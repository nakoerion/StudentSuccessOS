/**
 * Success-engine UI: pure view helpers, message parity in sq/en/ar, and the server
 * loaders + decision path against the seeded database as the RLS-enforced app role.
 */
import { createAdminClient, decideActionCard, prisma, type TenantTx, userMemberships, withTenant } from "@ssos/db";
import { loadSeedStudents, seedSuccessDemo } from "@ssos/db/seed/success";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import sq from "../messages/sq.json";
import { canViewSuccess, loadViewer } from "../lib/access";
import {
  loadInboxCards,
  loadRiskPanel,
  loadStudentAlerts,
  loadStudentHeader,
  loadTrackHistory,
  makeDateFormatters,
} from "../lib/success";
import {
  barPercent,
  canDecideCard,
  confidenceLevel,
  currentRung,
  DECISION_ERROR_CODES,
  parseDecisionForm,
  readAcknowledgements,
  readLadder,
  slaStatus,
  splitMinutes,
  sumContributions,
} from "../lib/success-view";
import { membershipForSlug } from "../lib/tenancy";

const owner = createAdminClient();
const TIRANA = "liceu-demo-tirane";
const ABU_DHABI = "demo-school-abu-dhabi";
const CARD = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

// A plain `pnpm db:seed` leaves the success tables empty (demo data is opt-in via
// SSOS_SEED_SUCCESS_DEMO=1). If Tirana has no scores, add the demo data here with the same
// seed code, and remove exactly what this file added afterwards so the database is left
// as seeded. If the tenant was seeded with the demo data, it is used as-is and kept.
const startedAt = new Date();
let addedDemo: string | null = null;
beforeAll(async () => {
  const tenantId = (await owner.tenant.findFirstOrThrow({ where: { slug: TIRANA }, select: { id: true } })).id;
  if ((await owner.riskScore.count({ where: { tenantId } })) > 0) return;
  await owner.$transaction(async (tx) => seedSuccessDemo(tx, tenantId, await loadSeedStudents(tx, tenantId), startedAt), { timeout: 120_000 });
  addedDemo = tenantId;
}, 180_000);

afterAll(async () => {
  if (addedDemo) {
    const tenantId = addedDemo;
    await owner.$transaction([
      owner.event.deleteMany({ where: { tenantId, occurredAt: { gte: startedAt } } }),
      owner.trackAssignment.deleteMany({ where: { tenantId } }),
      owner.alert.deleteMany({ where: { tenantId } }),
      owner.actionCard.deleteMany({ where: { tenantId } }),
      owner.riskScore.deleteMany({ where: { tenantId } }),
    ]);
  }
  await owner.$disconnect();
  await prisma.$disconnect();
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("view helpers (pure)", () => {
  it("canDecideCard mirrors the service: assignee role or admin", () => {
    expect(canDecideCard(["advisor"], "advisor")).toBe(true);
    expect(canDecideCard(["admin"], "advisor")).toBe(true);
    expect(canDecideCard(["teacher"], "advisor")).toBe(false);
    expect(canDecideCard([], "advisor")).toBe(false);
  });

  it("confidence buckets", () => {
    expect([0.9, 0.75, 0.74, 0.5, 0.49, 0].map(confidenceLevel)).toEqual(["high", "high", "medium", "medium", "low", "low"]);
  });

  it("parseDecisionForm validates ids, decisions and edits", () => {
    const base = { tenantSlug: TIRANA, actionCardId: CARD };
    expect(parseDecisionForm(form({ ...base, decision: "approve", note: "  ok " }))).toEqual({ ...base, decision: "approve", note: "ok" });
    expect(parseDecisionForm(form({ ...base, decision: "dismiss" }))).toEqual({ ...base, decision: "dismiss", note: null });
    expect(parseDecisionForm(form({ ...base, decision: "edit", track: "growth", effectiveDate: "2026-11-09", reviewDate: "" }))).toEqual({
      ...base,
      decision: "edit",
      note: null,
      edits: { track: "growth", effectiveDate: "2026-11-09" },
    });
    expect(parseDecisionForm(form({ ...base, decision: "edit", clearReview: "1", reviewDate: "2026-12-01" }))?.edits).toEqual({ reviewDate: null });
    expect(parseDecisionForm(form({ ...base, decision: "delete" }))).toBeNull();
    expect(parseDecisionForm(form({ ...base, actionCardId: "nope", decision: "approve" }))).toBeNull();
    expect(parseDecisionForm(form({ ...base, tenantSlug: "../x", decision: "approve" }))).toBeNull();
    expect(parseDecisionForm(form({ ...base, decision: "edit", track: "gold" }))).toBeNull();
    expect(parseDecisionForm(form({ ...base, decision: "edit", effectiveDate: "09/11/2026" }))).toBeNull();
    expect(parseDecisionForm(form({ ...base, decision: "approve", note: "x".repeat(1001) }))).toBeNull();
  });

  it("SLA status, durations, rungs, acknowledgements, bars and sums", () => {
    const now = new Date("2026-11-07T10:00:00Z");
    expect(slaStatus(null, now)).toEqual({ kind: "none" });
    expect(slaStatus(new Date("2026-11-07T12:30:00Z"), now)).toEqual({ kind: "due", minutesLeft: 150 });
    expect(slaStatus(new Date("2026-11-07T09:00:00Z"), now)).toEqual({ kind: "overdue", minutesOver: 60 });
    expect(splitMinutes(1 * 1440 + 125)).toEqual({ days: 1, hours: 2, minutes: 5 });
    const ladder = readLadder([
      { level: 2, role: "parent", slaMinutes: 10 },
      { level: 0, role: "teacher", slaMinutes: 10 },
      { level: 1, role: "advisor", slaMinutes: 10 },
      { bogus: true },
    ]);
    expect(ladder).toHaveLength(3);
    expect(currentRung(ladder, 1, "advisor")).toEqual({ rung: 2, of: 3, role: "advisor" });
    expect(currentRung([], 0, "teacher")).toEqual({ rung: 1, of: 1, role: "teacher" });
    expect(readAcknowledgements([{ personId: "p", role: "teacher", at: "2026-11-07T10:00:00Z", level: 0 }, { nope: 1 }])).toHaveLength(1);
    expect(barPercent(-5, 10)).toBe(50);
    expect(barPercent(50, 10)).toBe(100);
    expect(barPercent(1, 0)).toBe(0);
    expect(sumContributions([{ contribution: 10.1 }, { contribution: 20.2 }, { contribution: 0.03 }])).toBe(30.33);
  });
});

describe("messages", () => {
  const keys = (o: unknown, prefix = ""): string[] =>
    o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)) : [prefix];

  it("sq / en / ar have exactly the same keys", () => {
    const enKeys = keys(en).sort();
    expect(keys(sq).sort()).toEqual(enKeys);
    expect(keys(ar).sort()).toEqual(enKeys);
  });

  it("every decision error code has a message", () => {
    for (const m of [en, sq, ar]) for (const code of DECISION_ERROR_CODES) expect(m.success.errors[code]).toBeTruthy();
  });
});

async function ctx(email: string, slug = TIRANA) {
  const account = await owner.userAccount.findUniqueOrThrow({ where: { email } });
  const m = membershipForSlug(await userMemberships(account.id), slug);
  if (!m) throw new Error(`${email} has no active membership in ${slug}`);
  const viewer = await withTenant(m.tenantId, (tx) => loadViewer(tx, m.personId), { userId: account.id });
  const db = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(m.tenantId, fn, { userId: account.id });
  return { m, viewer, db, userId: account.id };
}

const fmt = makeDateFormatters("en", "Europe/Tirane");

describe("loaders + decisions (seeded tenant, app role)", () => {
  it("advisor sees open cards with evidence and may decide; teacher sees them read-only; parent has no access", async () => {
    const adv = await ctx("advisor.tirane@demo.ssos.test");
    expect(canViewSuccess(adv.viewer)).toBe(true);
    const cards = await adv.db((tx) => loadInboxCards(tx, { tenantId: adv.m.tenantId, viewer: adv.viewer, fmt }));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.canDecide).toBe(true);
      expect(c.evidence).not.toBeNull();
      expect(c.evidence!.topFactors.length).toBeGreaterThan(0);
      expect(c.evidence!.topFactors.length).toBeLessThanOrEqual(4);
      expect(c.proposal?.track).toMatch(/^(excellence|support)$/);
      expect(c.confidence).toBeGreaterThan(0);
    }
    const teacher = await ctx("teacher.tirane@demo.ssos.test");
    const tCards = await teacher.db((tx) => loadInboxCards(tx, { tenantId: teacher.m.tenantId, viewer: teacher.viewer, fmt }));
    expect(tCards.map((c) => c.id).sort()).toEqual(cards.map((c) => c.id).sort());
    expect(tCards.every((c) => !c.canDecide)).toBe(true);
    const parent = await ctx("parent.tirane@demo.ssos.test");
    expect(canViewSuccess(parent.viewer)).toBe(false);
  });

  it("risk panel: every factor listed, contributions sum to the score; alerts carry rung + SLA", async () => {
    const adv = await ctx("advisor.tirane@demo.ssos.test");
    const alerted = await owner.alert.findFirstOrThrow({ where: { tenantId: adv.m.tenantId }, select: { studentPersonId: true } });
    const { risk, alerts, header } = await adv.db(async (tx) => ({
      header: await loadStudentHeader(tx, alerted.studentPersonId),
      risk: await loadRiskPanel(tx, adv.m.tenantId, alerted.studentPersonId, fmt),
      alerts: await loadStudentAlerts(tx, adv.m.tenantId, alerted.studentPersonId, fmt),
    }));
    expect(header?.units.length).toBe(1);
    expect(risk).not.toBeNull();
    expect(risk!.factors).toHaveLength(7);
    expect(sumContributions(risk!.factors)).toBe(risk!.score);
    expect(risk!.factors.filter((f) => f.top).length).toBeLessThanOrEqual(4);
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.rung.rung).toBeGreaterThanOrEqual(1);
      expect(a.rung.of).toBe(3);
      expect(a.dueAt).not.toBeNull();
      expect(["due", "overdue"]).toContain(a.sla.kind);
      expect(a.acknowledgements).toEqual([]);
    }
  });

  it("another tenant's student is invisible (RLS): no header, no score", async () => {
    const tiranaStudent = await owner.person.findFirstOrThrow({ where: { tenant: { slug: TIRANA }, externalRef: { startsWith: "S-" } }, select: { id: true } });
    const ad = await ctx("admin.abudhabi@demo.ssos.test", ABU_DHABI);
    const res = await ad.db(async (tx) => ({
      header: await loadStudentHeader(tx, tiranaStudent.id),
      risk: await loadRiskPanel(tx, ad.m.tenantId, tiranaStudent.id, fmt),
    }));
    expect(res).toEqual({ header: null, risk: null });
  });

  it("approving a card through the app role writes the track; history shows who decided", async () => {
    const adv = await ctx("advisor.tirane@demo.ssos.test");
    const [card] = await adv.db((tx) => loadInboxCards(tx, { tenantId: adv.m.tenantId, viewer: adv.viewer, fmt }));
    expect(card).toBeDefined();
    const res = await adv.db((tx) =>
      decideActionCard(tx, { tenantId: adv.m.tenantId, actionCardId: card!.id, decision: "approve", deciderPersonId: adv.m.personId, actorUserId: adv.userId, note: "vitest" }),
    );
    expect(res.status).toBe("approved");
    const history = await adv.db((tx) => loadTrackHistory(tx, adv.m.tenantId, card!.student.id, fmt));
    expect(history[0]).toMatchObject({ track: card!.proposal!.track, status: "active", decision: { status: "approved", note: "vitest" } });
    expect(history[0]!.decision!.by).toBeTruthy();
    const after = await adv.db((tx) => loadInboxCards(tx, { tenantId: adv.m.tenantId, viewer: adv.viewer, fmt, subjectPersonId: card!.student.id }));
    expect(after).toEqual([]);
  });
});
