/**
 * Success engine slice 3a — track transitions as action cards.
 *
 *  - a recompute PROPOSES (card + evidence + confidence) and never changes a track;
 *  - no track change without an approved card (service AND database trigger);
 *  - approve / edit / dismiss; approve writes the track_assignment with effective and
 *    review dates and retires the previous one; one event per decision.
 *
 * DB cases run inside a transaction that is rolled back (owner, or the app role via
 * withTenant), so the shared database is left exactly as seeded.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActionCardError, type ActionCardErrorCode, decideActionCard, proposeTrack, TRACK_RULES } from "../src/action-cards";
import { type RiskFactorResult, recomputeStudentRisk } from "../src/risk-model";
import { DEFAULT_BAND_THRESHOLDS } from "../src/success-defaults";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A } from "./helpers";

type Tx = Prisma.TransactionClient;
const D = (v: number | string) => new Prisma.Decimal(v);
const AS_OF = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let owner: PrismaClient;
let app: PrismaClient;
beforeAll(() => {
  owner = ownerClient();
  app = appClient();
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

async function rolledBack<T>(client: "owner" | "app", fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  const body = async (tx: Tx) => {
    out = await fn(tx);
    throw new Rollback();
  };
  const p = client === "owner" ? owner.$transaction(body, { timeout: 180_000, maxWait: 30_000 }) : withTenant(TENANT_A, body, { client: app, timeoutMs: 180_000 });
  await p.catch((e: unknown) => {
    if (!(e instanceof Rollback)) throw e;
  });
  return out as T;
}

async function expectCode(p: Promise<unknown>, code: ActionCardErrorCode) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ActionCardError);
  expect((err as ActionCardError).code).toBe(code);
}

/** Grade-10 student of tenant A with one course; helpers write grades / attendance for them. */
async function fixture(tx: Tx) {
  const term = await tx.term.findFirstOrThrow({ where: { tenantId: TENANT_A, startsOn: { lte: AS_OF }, endsOn: { gte: AS_OF } } });
  const enr = await tx.enrollment.findFirstOrThrow({
    where: { tenantId: TENANT_A, status: "active", classSection: { course: { grade: "10", academicYearId: term.academicYearId } } },
    select: { id: true, studentPersonId: true, classSection: { select: { course: { select: { gradeScale: true, assessmentCategories: { take: 1, orderBy: { name: "asc" } } } } } } },
    orderBy: [{ studentPersonId: "asc" }, { id: "asc" }],
  });
  const c = enr.classSection.course;
  let day = 0;
  return {
    student: enr.studentPersonId,
    grades: (pcts: number[]) =>
      tx.gradeEntry.createMany({
        data: pcts.map((p) => ({
          tenantId: TENANT_A,
          enrollmentId: enr.id,
          assessmentCategoryId: c.assessmentCategories[0]!.id,
          termId: term.id,
          gradeScaleId: c.gradeScale!.id,
          rawMark: D(p).mul(c.gradeScale!.maxValue).div(100).toDecimalPlaces(2),
          gradedAt: new Date(Date.UTC(2026, 10, 1, 9) + day++ * 60_000),
        })),
      }),
    attendance: (statuses: ("present" | "absent" | "late")[]) =>
      tx.attendanceEvent.createMany({
        data: statuses.map((status, i) => ({ tenantId: TENANT_A, enrollmentId: enr.id, studentPersonId: enr.studentPersonId, date: new Date(Date.UTC(2026, 10, 16 + i)), status })),
      }),
  };
}

/** A person of tenant A holding the given system role. */
async function personWithRole(db: Tx | PrismaClient, key: string): Promise<string> {
  const ra = await db.roleAssignment.findFirstOrThrow({ where: { tenantId: TENANT_A, status: "active", role: { key } }, select: { personId: true }, orderBy: { personId: "asc" } });
  return ra.personId;
}

const factor = (f: string, available: boolean, weight: number, value: number | null = null): RiskFactorResult => ({
  factor: f as RiskFactorResult["factor"],
  available,
  value,
  risk: null,
  weight,
  effectiveWeight: 0,
  contribution: 0,
  baseline: null,
  vsBaseline: null,
  rank: null,
  top: false,
});

// ─── Pure ─────────────────────────────────────────────────────────────────────

describe("action cards: track rule and confidence (pure)", () => {
  const T = DEFAULT_BAND_THRESHOLDS; // 30 / 55 / 75
  const full = (grade: number | null) => [factor("gradeLevel", grade !== null, 0.5, grade), factor("attendanceLevel", true, 0.5, 90)];

  it("high/critical -> support; low with grades >= 85 -> excellence; otherwise growth", () => {
    expect(proposeTrack({ score: 80, band: "critical", factors: full(40) }, T).track).toBe("support");
    expect(proposeTrack({ score: 60, band: "high", factors: full(50) }, T).track).toBe("support");
    expect(proposeTrack({ score: 10, band: "low", factors: full(92) }, T)).toMatchObject({ track: "excellence", rule: "band_low_and_grades_high" });
    expect(proposeTrack({ score: 10, band: "low", factors: full(80) }, T).track).toBe("growth");
    expect(proposeTrack({ score: 10, band: "low", factors: full(null) }, T).track).toBe("growth");
    expect(proposeTrack({ score: 40, band: "moderate", factors: full(95) }, T).track).toBe("growth");
  });

  it("confidence = coverage × (0.5 + 0.5 × min(1, margin / 10)), 3 dp", () => {
    // Full coverage, 25 points above 'critical'... nearest threshold 75 -> margin 15 -> full.
    expect(proposeTrack({ score: 90, band: "critical", factors: full(30) }, T)).toMatchObject({ coverage: 1, margin: 15, confidence: 1 });
    // On the boundary: margin 0 -> half confidence.
    expect(proposeTrack({ score: 55, band: "high", factors: full(30) }, T)).toMatchObject({ margin: 0, confidence: 0.5 });
    // Half the configured weight without data -> coverage 0.5; margin 5 -> 0.75 × 0.5.
    const half = [factor("gradeLevel", true, 0.5, 30), factor("attendanceLevel", false, 0.5)];
    expect(proposeTrack({ score: 60, band: "high", factors: half }, T)).toMatchObject({ coverage: 0.5, margin: 5, confidence: 0.375 });
    // Excellence: margin also bounded by the grade points above the bar (86 − 85 = 1).
    expect(proposeTrack({ score: 5, band: "low", factors: full(86) }, T)).toMatchObject({ track: "excellence", margin: 1, confidence: 0.55 });
  });
});

// ─── Recompute proposes, never applies ───────────────────────────────────────

describe("action cards: a recompute proposes a track transition and never applies it", () => {
  it("critical student -> one proposed support card with evidence + confidence; no track_assignment; idempotent", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const fx = await fixture(tx);
      await fx.grades([80, 70, 50, 40]);
      await fx.attendance(["present", "absent", "absent", "late"]);
      const tracksBefore = await tx.trackAssignment.count({ where: { tenantId: TENANT_A } });
      const first = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      const second = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      const cards = await tx.actionCard.findMany({ where: { tenantId: TENANT_A, subjectPersonId: fx.student } });
      const events = await tx.event.findMany({ where: { tenantId: TENANT_A, entityType: "action_card", subjectPersonId: fx.student } });
      return { fx, first, second, cards, events, tracksBefore, tracksAfter: await tx.trackAssignment.count({ where: { tenantId: TENANT_A } }) };
    });
    expect(r.first.status).toBe("scored");
    if (r.first.status !== "scored" || r.second.status !== "scored") throw new Error("expected scored");
    expect(r.first.riskScore.band).toBe("critical");
    expect(r.first.proposal).toMatchObject({ status: "proposed", track: "support", fromTrack: null });
    expect(r.second.proposal).toMatchObject({ status: "already_proposed", track: "support" });

    expect(r.cards).toHaveLength(1);
    const card = r.cards[0]!;
    expect(card).toMatchObject({ type: "track_transition", status: "proposed", assigneeRole: "advisor", sourceRiskScoreId: r.first.riskScore.id });
    expect(card.evidenceRefs).toEqual([{ type: "risk_score", id: r.first.riskScore.id }]);
    const payload = card.proposedPayload as Record<string, unknown>;
    expect(payload).toMatchObject({ track: "support", fromTrack: null, currentTrackAssignmentId: null, score: 75, band: "critical", reviewAfterDays: TRACK_RULES.reviewAfterDays });
    expect((payload.topFactors as unknown[]).length).toBeGreaterThan(0);
    expect(card.confidence.toNumber()).toBeGreaterThan(0);
    expect(card.confidence.toNumber()).toBeLessThanOrEqual(1);
    expect(card.expiresAt!.getTime() - card.createdAt.getTime()).toBeGreaterThan((TRACK_RULES.cardExpiresAfterDays - 1) * DAY);
    // Exactly one event for the one card mutation.
    expect(r.events.map((e) => e.type)).toEqual(["action_card.proposed"]);
    // NOTHING applied.
    expect(r.tracksAfter).toBe(r.tracksBefore);
  });

  it("a student whose data no longer points away from their track gets the open card expired", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const fx = await fixture(tx);
      await fx.grades([80, 70, 50, 40]);
      await fx.attendance(["present", "absent", "absent", "late"]);
      const first = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      // Recovery: many strong marks, full attendance afterwards -> moderate at most -> growth (= default track).
      await fx.grades([95, 95, 95, 95, 95, 95, 95, 95]); // mean 83.3% < 85: growth, not excellence
      await tx.attendanceEvent.updateMany({ where: { tenantId: TENANT_A, studentPersonId: fx.student }, data: { status: "present" } });
      const second = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      return { first, second, cards: await tx.actionCard.findMany({ where: { tenantId: TENANT_A, subjectPersonId: fx.student } }) };
    });
    if (r.first.status !== "scored" || r.second.status !== "scored") throw new Error("expected scored");
    expect(r.second.riskScore.band === "low" || r.second.riskScore.band === "moderate").toBe(true);
    expect(r.second.proposal?.status).toBe("no_change");
    expect(r.cards.map((c) => c.status)).toEqual(["expired"]);
  });
});

// ─── No track change without an approved card (database) ─────────────────────

describe("action cards: the database refuses any track change without an approved card", () => {
  it("app role: no card / proposed / dismissed card / wrong track -> rejected; born-approved cards are rejected too", async () => {
    const results = await rolledBack("app", async (tx) => {
      const student = (await tx.person.findFirstOrThrow({ where: { externalRef: "S-001" } })).id;
      const base = { tenantId: TENANT_A, studentPersonId: student, confidence: "0.700", effectiveDate: new Date("2026-11-09") };
      const card = (status?: "approved") =>
        tx.actionCard.create({
          data: { tenantId: TENANT_A, type: "track_transition", subjectPersonId: student, confidence: "0.7", proposedPayload: { track: "support" }, assigneeRole: "advisor", ...(status ? { status } : {}) },
        });
      const attempt = async (label: string, fn: () => Promise<unknown>) => {
        // Savepoint so one rejected statement does not abort the surrounding transaction.
        await tx.$executeRawUnsafe(`SAVEPOINT s`);
        try {
          await fn();
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT s`);
          return `${label}: accepted`;
        } catch (e) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s`);
          const m = String((e as Error).message);
          return `${label}: ${/track_assignment_requires_approved_card/.test(m) ? "no_approved_card" : /action_card_lifecycle/.test(m) ? "lifecycle" : m}`;
        }
      };
      const out: string[] = [];
      out.push(await attempt("no card", () => tx.trackAssignment.create({ data: { ...base, track: "support" } })));
      const proposed = await card();
      out.push(await attempt("proposed card", () => tx.trackAssignment.create({ data: { ...base, track: "support", actionCardId: proposed.id } })));
      out.push(await attempt("born approved", () => card("approved")));
      await tx.actionCard.update({ where: { id: proposed.id }, data: { status: "dismissed", decidedAt: new Date() } });
      out.push(await attempt("dismissed card", () => tx.trackAssignment.create({ data: { ...base, track: "support", actionCardId: proposed.id } })));
      out.push(await attempt("reopen decided card", () => tx.actionCard.update({ where: { id: proposed.id }, data: { status: "proposed" } })));
      // Approved card for "support" cannot be used for another track, nor twice.
      const ok = await card();
      await tx.actionCard.update({ where: { id: ok.id }, data: { status: "approved", decidedAt: new Date() } });
      out.push(await attempt("wrong track", () => tx.trackAssignment.create({ data: { ...base, track: "excellence", actionCardId: ok.id } })));
      out.push(await attempt("approved card", () => tx.trackAssignment.create({ data: { ...base, track: "support", actionCardId: ok.id } })));
      const ta = await tx.trackAssignment.findFirstOrThrow({ where: { actionCardId: ok.id } });
      out.push(await attempt("rewrite track", () => tx.trackAssignment.update({ where: { id: ta.id }, data: { track: "growth" } })));
      out.push(await attempt("retire", () => tx.trackAssignment.update({ where: { id: ta.id }, data: { status: "ended" } })));
      out.push(await attempt("reactivate", () => tx.trackAssignment.update({ where: { id: ta.id }, data: { status: "active" } })));
      return out;
    });
    expect(results).toEqual([
      "no card: no_approved_card",
      "proposed card: no_approved_card",
      "born approved: lifecycle",
      "dismissed card: no_approved_card",
      "reopen decided card: lifecycle",
      "wrong track: no_approved_card",
      "approved card: accepted",
      "rewrite track: no_approved_card",
      "retire: accepted",
      "reactivate: no_approved_card",
    ]);
  });
});

// ─── Decisions ───────────────────────────────────────────────────────────────

describe("action cards: decideActionCard", () => {
  it("approve (app role, advisor): applies the track with effective + review dates; one event; cannot be decided twice", async () => {
    const r = await rolledBack("app", async (tx) => {
      const advisor = await personWithRole(tx, "advisor");
      const student = (await tx.person.findFirstOrThrow({ where: { externalRef: "S-002" } })).id;
      const card = await tx.actionCard.create({
        data: {
          tenantId: TENANT_A,
          type: "track_transition",
          subjectPersonId: student,
          confidence: "0.812",
          evidenceRefs: [{ type: "risk_score", id: "00000000-0000-4000-8000-000000000001" }],
          proposedPayload: { track: "support", fromTrack: null, currentTrackAssignmentId: null, reviewAfterDays: 42 },
          assigneeRole: "advisor",
        },
      });
      const now = new Date("2026-11-09T08:30:00Z");
      const res = await decideActionCard(tx, { tenantId: TENANT_A, actionCardId: card.id, decision: "approve", deciderPersonId: advisor, note: "Agreed with form tutor", now });
      const again = await decideActionCard(tx, { tenantId: TENANT_A, actionCardId: card.id, decision: "dismiss", deciderPersonId: advisor, now }).catch((e: unknown) => e);
      return {
        res,
        again,
        advisor,
        card: await tx.actionCard.findUniqueOrThrow({ where: { id: card.id } }),
        tracks: await tx.trackAssignment.findMany({ where: { studentPersonId: student } }),
        events: await tx.event.findMany({ where: { entityType: "action_card", entityId: card.id } }),
      };
    });
    expect(r.res).toMatchObject({ status: "approved", supersededTrackAssignmentId: null });
    expect(r.res.trackAssignment).toMatchObject({ track: "support", effectiveDate: "2026-11-09", reviewDate: "2026-12-21", confidence: 0.812 });
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]).toMatchObject({ track: "support", status: "active", actionCardId: r.res.actionCardId });
    expect(r.tracks[0]!.evidenceRefs).toEqual([
      { type: "action_card", id: r.res.actionCardId },
      { type: "risk_score", id: "00000000-0000-4000-8000-000000000001" },
    ]);
    expect(r.card).toMatchObject({ status: "approved", decidedByPersonId: r.advisor, decisionNote: "Agreed with form tutor" });
    expect(r.card.decidedPayload).toMatchObject({ track: "support", effectiveDate: "2026-11-09", reviewDate: "2026-12-21" });
    expect(r.events.map((e) => e.type)).toEqual(["action_card.approved"]);
    expect(r.events[0]!.actorPersonId).toBe(r.advisor);
    expect(r.again).toBeInstanceOf(ActionCardError);
    expect((r.again as ActionCardError).code).toBe("already_decided");
  });

  it("recompute -> approve -> recovery -> approve again: the old track is superseded, never rewritten", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const fx = await fixture(tx);
      const advisor = await personWithRole(tx, "advisor");
      await fx.grades([80, 70, 50, 40]);
      await fx.attendance(["present", "absent", "absent", "late"]);
      const s1 = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      if (s1.status !== "scored" || s1.proposal?.status !== "proposed") throw new Error("expected a proposal");
      const a1 = await decideActionCard(tx, { tenantId: TENANT_A, actionCardId: s1.proposal.actionCardId, decision: "approve", deciderPersonId: advisor });
      // Same data again: the student is now on support already -> nothing to propose.
      const same = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      await fx.grades([95, 95, 95, 95, 95, 95, 95, 95]); // mean 83.3% < 85: growth, not excellence
      await tx.attendanceEvent.updateMany({ where: { tenantId: TENANT_A, studentPersonId: fx.student }, data: { status: "present" } });
      const s2 = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.student, asOf: AS_OF });
      if (s2.status !== "scored" || s2.proposal?.status !== "proposed") throw new Error("expected a second proposal");
      const card2 = await tx.actionCard.findUniqueOrThrow({ where: { id: s2.proposal.actionCardId } });
      const a2 = await decideActionCard(tx, {
        tenantId: TENANT_A,
        actionCardId: card2.id,
        decision: "edit",
        deciderPersonId: advisor,
        edits: { effectiveDate: "2026-12-14", reviewDate: null },
      });
      return { a1, same, s2, card2, a2, tracks: await tx.trackAssignment.findMany({ where: { tenantId: TENANT_A, studentPersonId: fx.student }, orderBy: { createdAt: "asc" } }) };
    });
    expect(r.a1.trackAssignment?.track).toBe("support");
    expect(r.same.status === "scored" && r.same.proposal?.status).toBe("no_change");
    expect(r.s2.status === "scored" && r.s2.proposal).toMatchObject({ track: "growth", fromTrack: "support" });
    expect((r.card2.proposedPayload as { currentTrackAssignmentId: string }).currentTrackAssignmentId).toBe(r.a1.trackAssignment!.id);
    expect(r.a2).toMatchObject({ status: "edited", supersededTrackAssignmentId: r.a1.trackAssignment!.id });
    expect(r.a2.trackAssignment).toMatchObject({ track: "growth", effectiveDate: "2026-12-14", reviewDate: null });
    expect(r.tracks.map((t) => [t.track, t.status])).toEqual([
      ["support", "superseded"],
      ["growth", "active"],
    ]);
  });

  it("edit can change the track and dates; dismiss changes nothing but the card", async () => {
    const r = await rolledBack("app", async (tx) => {
      const advisor = await personWithRole(tx, "advisor");
      const students = await tx.person.findMany({ where: { externalRef: { in: ["S-003", "S-004"] } }, orderBy: { externalRef: "asc" } });
      const mk = (student: string) =>
        tx.actionCard.create({
          data: { tenantId: TENANT_A, type: "track_transition", subjectPersonId: student, confidence: "0.6", proposedPayload: { track: "support", currentTrackAssignmentId: null, reviewAfterDays: 42 }, assigneeRole: "advisor" },
        });
      const [c1, c2] = [await mk(students[0]!.id), await mk(students[1]!.id)];
      const edited = await decideActionCard(tx, {
        tenantId: TENANT_A,
        actionCardId: c1.id,
        decision: "edit",
        deciderPersonId: advisor,
        edits: { track: "excellence", effectiveDate: "2026-11-16", reviewDate: "2027-01-11" },
        now: new Date("2026-11-10T10:00:00Z"),
      });
      const dismissed = await decideActionCard(tx, { tenantId: TENANT_A, actionCardId: c2.id, decision: "dismiss", deciderPersonId: advisor, note: "Known situation" });
      return {
        edited,
        dismissed,
        c1: await tx.actionCard.findUniqueOrThrow({ where: { id: c1.id } }),
        c2: await tx.actionCard.findUniqueOrThrow({ where: { id: c2.id } }),
        tracks2: await tx.trackAssignment.count({ where: { studentPersonId: students[1]!.id } }),
        events: await tx.event.findMany({ where: { entityType: "action_card", entityId: { in: [c1.id, c2.id] } }, orderBy: { type: "asc" } }),
      };
    });
    expect(r.edited.trackAssignment).toMatchObject({ track: "excellence", effectiveDate: "2026-11-16", reviewDate: "2027-01-11" });
    expect(r.c1.status).toBe("edited");
    expect(r.c1.decidedPayload).toMatchObject({ track: "excellence" });
    expect((r.c1.proposedPayload as { track: string }).track).toBe("support");
    expect(r.dismissed).toMatchObject({ status: "dismissed", trackAssignment: null });
    expect(r.c2).toMatchObject({ status: "dismissed", decisionNote: "Known situation" });
    expect(r.tracks2).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(["action_card.dismissed", "action_card.edited"]);
  });

  it("rejects: unknown card, wrong role, expired, stale, bad dates, approve-with-other-track, edit without changes", async () => {
    await rolledBack("app", async (tx) => {
      const advisor = await personWithRole(tx, "advisor");
      const teacher = await personWithRole(tx, "teacher");
      const student = (await tx.person.findFirstOrThrow({ where: { externalRef: "S-005" } })).id;
      const mk = (extra: Partial<Prisma.ActionCardUncheckedCreateInput> = {}) =>
        tx.actionCard.create({
          data: { tenantId: TENANT_A, type: "track_transition", subjectPersonId: student, confidence: "0.6", proposedPayload: { track: "support", currentTrackAssignmentId: null }, assigneeRole: "advisor", ...extra },
        });
      const base = { tenantId: TENANT_A, deciderPersonId: advisor };
      await expectCode(decideActionCard(tx, { ...base, actionCardId: "00000000-0000-4000-8000-000000000000", decision: "approve" }), "unknown_card");
      const c = await mk();
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", deciderPersonId: teacher }), "not_authorized");
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", deciderPersonId: "00000000-0000-4000-8000-000000000000" }), "unknown_decider");
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", edits: { track: "growth" } }), "invalid_decision");
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "edit" }), "invalid_decision");
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", edits: { effectiveDate: "2026-02-30" } }), "invalid_payload");
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", edits: { effectiveDate: "2026-12-01", reviewDate: "2026-11-01" } }), "invalid_payload");
      await tx.actionCard.update({ where: { id: c.id }, data: { expiresAt: new Date("2026-11-01T00:00:00Z") } });
      await expectCode(decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve", now: new Date("2026-11-02T00:00:00Z") }), "card_expired");
      await tx.actionCard.update({ where: { id: c.id }, data: { expiresAt: null } });
      const other = await mk({ type: "intervention", proposedPayload: {} });
      await expectCode(decideActionCard(tx, { ...base, actionCardId: other.id, decision: "approve" }), "unsupported_card_type");
      await decideActionCard(tx, { ...base, actionCardId: c.id, decision: "approve" });
      await tx.trackAssignment.updateMany({ where: { studentPersonId: student, status: "active" }, data: { status: "ended" } });
      // Stale: proposed against an assignment that is no longer the active one.
      const late = await mk({ proposedPayload: { track: "growth", currentTrackAssignmentId: "00000000-0000-4000-8000-0000000000aa" } });
      await expectCode(decideActionCard(tx, { ...base, actionCardId: late.id, decision: "approve" }), "stale_card");
      // Nothing was applied by any rejected call: exactly the one approved assignment exists.
      expect(await tx.trackAssignment.count({ where: { studentPersonId: student } })).toBe(1);
    });
  });
});
