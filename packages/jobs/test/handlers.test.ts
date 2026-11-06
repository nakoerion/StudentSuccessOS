/**
 * @ssos/jobs handlers WITHOUT a live queue: the handlers are plain functions over an owner
 * Prisma client/transaction, so each case runs inside an owner transaction that is rolled
 * back — the shared database is left exactly as seeded.
 */
import { createAdminClient, createGoal, type Prisma, type PrismaClient } from "@ssos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOMAIN_EVENTS, type DomainEvent, EVENT_TYPE_TOPICS, QUEUES, SCHEDULES, studentQueueFor } from "../src/events";
import { createHandlers, type JobDeps, RELAY_CURSOR, setRelayCursor } from "../src/handlers";
import { type BossJob, type BossLike, registerSuccessJobs } from "../src/register";

type Tx = Prisma.TransactionClient;
const AS_OF = new Date("2026-12-10T12:00:00Z");
const TENANT_A_SLUG = "liceu-demo-tirane";

let owner: PrismaClient;
let tenantA: string;
beforeAll(async () => {
  owner = createAdminClient();
  tenantA = (await owner.tenant.findFirstOrThrow({ where: { slug: TENANT_A_SLUG } })).id;
});
afterAll(async () => {
  await owner.$disconnect();
});

class Rollback extends Error {}
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await owner
    .$transaction(
      async (tx) => {
        out = await fn(tx);
        throw new Rollback();
      },
      { timeout: 180_000, maxWait: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

interface Recorder {
  published: { topic: DomainEvent; data: unknown; id: string }[];
  sent: { queue: string; data: object }[];
}
function deps(db: JobDeps["db"], extra: Partial<JobDeps> = {}): JobDeps & { rec: Recorder } {
  const rec: Recorder = { published: [], sent: [] };
  return {
    db,
    rec,
    publish: async (topic, data, { id }) => {
      rec.published.push({ topic, data, id });
    },
    send: async (queue, data) => {
      rec.sent.push({ queue, data });
    },
    now: () => AS_OF,
    ...extra,
  };
}

/** Grade-10 cohort of tenant A: first student gets falling grades + poor attendance. */
async function cohortWithData(tx: Tx) {
  const term = await tx.term.findFirstOrThrow({ where: { tenantId: tenantA, startsOn: { lte: AS_OF }, endsOn: { gte: AS_OF } } });
  const enr = await tx.enrollment.findMany({
    where: { tenantId: tenantA, status: "active", classSection: { course: { grade: "10", academicYearId: term.academicYearId } } },
    select: { id: true, studentPersonId: true, classSection: { select: { course: { select: { gradeScale: true, assessmentCategories: { take: 1, orderBy: { name: "asc" } } } } } } },
    orderBy: [{ studentPersonId: "asc" }, { id: "asc" }],
  });
  const first = new Map<string, (typeof enr)[number]>();
  for (const e of enr) if (!first.has(e.studentPersonId)) first.set(e.studentPersonId, e);
  const rows = [...first.values()];
  const grade = (e: (typeof rows)[number], pcts: number[]) =>
    tx.gradeEntry.createMany({
      data: pcts.map((p, i) => ({
        tenantId: tenantA,
        enrollmentId: e.id,
        assessmentCategoryId: e.classSection.course.assessmentCategories[0]!.id,
        termId: term.id,
        gradeScaleId: e.classSection.course.gradeScale!.id,
        rawMark: e.classSection.course.gradeScale!.maxValue.mul(p).div(100).toDecimalPlaces(2),
        gradedAt: new Date(Date.UTC(2026, 10, 1 + i, 9)),
      })),
    });
  await grade(rows[0]!, [80, 70, 50, 40]);
  await grade(rows[1]!, [90, 90]);
  await grade(rows[2]!, [60]);
  await tx.attendanceEvent.createMany({
    data: (["present", "absent", "absent", "late"] as const).map((status, i) => ({
      tenantId: tenantA,
      enrollmentId: rows[0]!.id,
      studentPersonId: rows[0]!.studentPersonId,
      date: new Date(Date.UTC(2026, 10, 16 + i)),
      status,
    })),
  });
  return rows.map((r) => r.studentPersonId);
}

const snapshot = async (tx: Tx) => ({
  scores: await tx.riskScore.findMany({ where: { tenantId: tenantA }, select: { id: true, studentPersonId: true } }),
  cards: await tx.actionCard.findMany({ where: { tenantId: tenantA }, select: { id: true, subjectPersonId: true, status: true } }),
  tracks: await tx.trackAssignment.count({ where: { tenantId: tenantA } }),
});
const added = <T extends { id: string }>(before: T[], after: T[]) => after.filter((a) => !before.some((b) => b.id === a.id));

// ─── Wiring ───────────────────────────────────────────────────────────────────

describe("jobs: registration (fake boss)", () => {
  it("one subscriber queue per domain event, the tenant queue, and the nightly, relay, escalation and nudge schedules", async () => {
    const calls = { queues: [] as string[], subs: [] as [string, string][], workers: new Map<string, (jobs: BossJob[]) => Promise<unknown>>(), schedules: [] as [string, string, string | undefined][] };
    const boss: BossLike = {
      createQueue: async (name) => void calls.queues.push(name),
      subscribe: async (event, name) => void calls.subs.push([event, name]),
      work: async (name, handler) => {
        calls.workers.set(name, handler);
        return name;
      },
      schedule: async (name, cron, _data, options) => void calls.schedules.push([name, cron, options?.tz]),
    };
    const seen: [string, unknown][] = [];
    const handlers = {
      onStudentEvent: async (topic: DomainEvent, data: unknown) => (seen.push([topic, data]), { status: "skipped" as const, reason: "test", topic }),
      recomputeTenant: async () => ({ status: "skipped" as const }),
      nightly: async () => ({ tenants: 0 }),
      relayDomainEvents: async () => ({ scanned: 0, published: 0, skipped: 0, cursor: null }),
      escalateAlerts: async () => ({ due: 0, escalated: 0, slaExpired: 0, steps: [] }),
      goalNudges: async () => ({ goals: 0, sent: 0, alreadyNudged: 0 }),
    };
    const reg = await registerSuccessJobs(boss, handlers);
    expect(DOMAIN_EVENTS).toEqual(["student.graded", "attendance.marked", "submission.late", "note.created"]);
    expect(calls.subs).toEqual(DOMAIN_EVENTS.map((e) => [e, studentQueueFor(e)]));
    expect(reg.subscriptions).toHaveLength(4);
    expect(new Set(calls.queues)).toEqual(new Set([...DOMAIN_EVENTS.map(studentQueueFor), QUEUES.recomputeTenant, QUEUES.nightly, QUEUES.relay, QUEUES.escalateAlerts, QUEUES.goalNudges]));
    expect(calls.schedules).toEqual([
      [QUEUES.nightly, SCHEDULES.nightly, "UTC"],
      [QUEUES.relay, SCHEDULES.relay, "UTC"],
      [QUEUES.escalateAlerts, "* * * * *", "UTC"],
      [QUEUES.goalNudges, SCHEDULES.goalNudges, "UTC"],
    ]);
    // Every queue has a worker, and a student queue routes to onStudentEvent with its topic.
    for (const q of calls.queues) expect(calls.workers.has(q), q).toBe(true);
    await calls.workers.get(studentQueueFor("note.created"))!([{ id: "j1", data: { tenantId: "x" } }]);
    expect(seen).toEqual([["note.created", { tenantId: "x" }]]);
  });

  it("the relay maps the producers' event types to the four topics", () => {
    expect(EVENT_TYPE_TOPICS).toEqual({
      "grade_entry.created": "student.graded",
      "attendance.recorded": "attendance.marked",
      "submission.late": "submission.late",
      "note.created": "note.created",
    });
  });
});

// ─── Student topics ───────────────────────────────────────────────────────────

describe("jobs: student topics recompute only the affected student", () => {
  it("student.graded -> one new risk_score row, for that student only; cards only for that student; no track change", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      const before = await snapshot(tx);
      const h = createHandlers(deps(tx));
      const res = await h.onStudentEvent("student.graded", { tenantId: tenantA, studentPersonId: students[0], eventId: "00000000-0000-4000-8000-000000000001" });
      return { students, before, res, after: await snapshot(tx) };
    });
    expect(r.res).toMatchObject({ status: "scored", studentPersonId: r.students[0], score: 75, proposal: { status: "proposed", track: "support" } });
    const newScores = added(r.before.scores, r.after.scores);
    expect(newScores).toHaveLength(1);
    expect(newScores[0]!.studentPersonId).toBe(r.students[0]);
    const newCards = added(r.before.cards, r.after.cards);
    expect(newCards.map((c) => [c.subjectPersonId, c.status])).toEqual([[r.students[0], "proposed"]]);
    expect(r.after.tracks).toBe(r.before.tracks);
  });

  it("attendance.marked, submission.late and note.created run the same single-student recompute", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      const h = createHandlers(deps(tx));
      const out: Record<string, unknown> = {};
      const before = await snapshot(tx);
      for (const topic of ["attendance.marked", "submission.late", "note.created"] as const) {
        out[topic] = await h.onStudentEvent(topic, { tenantId: tenantA, studentPersonId: students[1] });
      }
      return { students, out, before, after: await snapshot(tx) };
    });
    for (const topic of ["attendance.marked", "submission.late", "note.created"]) expect(r.out[topic]).toMatchObject({ status: "scored", studentPersonId: r.students[1] });
    const newScores = added(r.before.scores, r.after.scores);
    expect(newScores).toHaveLength(3);
    expect(new Set(newScores.map((s) => s.studentPersonId))).toEqual(new Set([r.students[1]]));
  });

  it("unusable payloads and students without anything to score are skipped (no retry), writing nothing", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      const teacher = await tx.person.findFirstOrThrow({ where: { tenantId: tenantA, externalRef: { startsWith: "T-" } } });
      const h = createHandlers(deps(tx));
      const before = await snapshot(tx);
      const out = [
        await h.onStudentEvent("student.graded", null),
        await h.onStudentEvent("student.graded", { tenantId: tenantA, studentPersonId: "not-a-uuid" }),
        await h.onStudentEvent("note.created", { tenantId: tenantA, studentPersonId: "00000000-0000-4000-8000-000000000000" }),
        await h.onStudentEvent("submission.late", { tenantId: tenantA, studentPersonId: teacher.id }),
        await h.onStudentEvent("attendance.marked", { tenantId: tenantA, studentPersonId: students[5] }),
      ];
      return { out, before, after: await snapshot(tx) };
    });
    expect(r.out.map((o) => (o.status === "skipped" ? `skipped:${o.reason}` : o.status))).toEqual([
      "skipped:invalid_payload",
      "skipped:invalid_payload",
      "skipped:unknown_student",
      "skipped:not_enrolled",
      "insufficient_data",
    ]);
    expect(r.after).toEqual(r.before);
  });
});

// ─── Nightly + tenant recompute ───────────────────────────────────────────────

describe("jobs: nightly full recompute", () => {
  it("nightly fans out one recompute-tenant job per tenant with an active risk model", async () => {
    const d = deps(owner);
    const res = await createHandlers(d).nightly();
    const active = await owner.riskModelConfig.findMany({ where: { isActive: true }, select: { tenantId: true } });
    expect(res.tenants).toBe(active.length);
    expect(res.tenants).toBeGreaterThanOrEqual(2);
    expect(d.rec.sent.map((s) => s.queue)).toEqual(active.map(() => QUEUES.recomputeTenant));
    expect(new Set(d.rec.sent.map((s) => (s.data as { tenantId: string }).tenantId))).toEqual(new Set(active.map((a) => a.tenantId)));
  });

  it("recompute-tenant scores every scorable student, proposes cards, expires stale ones — and changes no track", async () => {
    const r = await rolledBack(async (tx) => {
      await cohortWithData(tx);
      const anyStudent = (await tx.enrollment.findFirstOrThrow({ where: { tenantId: tenantA, status: "active" }, orderBy: { id: "desc" } })).studentPersonId;
      const stale = await tx.actionCard.create({
        data: { tenantId: tenantA, type: "intervention", subjectPersonId: anyStudent, confidence: "0.5", proposedPayload: {}, assigneeRole: "advisor", expiresAt: new Date("2026-11-01T00:00:00Z") },
      });
      const before = await snapshot(tx);
      const res = await createHandlers(deps(tx)).recomputeTenant({ tenantId: tenantA });
      return { res, before, after: await snapshot(tx), stale: await tx.actionCard.findUniqueOrThrow({ where: { id: stale.id } }) };
    });
    expect(r.res).toMatchObject({ status: "recomputed", scored: 3, expiredCards: 1 });
    // s0 critical -> support; s1 low with 90% -> excellence; s2 moderate -> growth (= default).
    expect(r.res.proposals).toEqual({ proposed: 2, already_proposed: 0, no_change: 1 });
    expect(added(r.before.scores, r.after.scores)).toHaveLength(3);
    expect(r.stale.status).toBe("expired");
    expect(r.after.tracks).toBe(r.before.tracks);
    expect(await createHandlers(deps(owner)).recomputeTenant({ tenantId: "nope" })).toEqual({ status: "skipped", reason: "invalid_payload" });
  });
});

// ─── Outbox relay ─────────────────────────────────────────────────────────────

describe("jobs: domain-event relay (event table -> topics)", () => {
  it("publishes mapped events after the cursor with the event id as job id, skips subject-less rows, advances the cursor", async () => {
    const r = await rolledBack(async (tx) => {
      const student = (await tx.person.findFirstOrThrow({ where: { tenantId: tenantA, externalRef: "S-001" } })).id;
      await setRelayCursor(tx, new Date("2019-12-31T00:00:00Z"));
      const at = (s: number) => new Date(Date.UTC(2020, 0, 1, 0, 0, s));
      const mk = (type: string, s: number, subject: string | null) =>
        tx.event.create({ data: { tenantId: tenantA, type, subjectPersonId: subject, createdAt: at(s) }, select: { id: true } });
      const ignored = await mk("risk_model_config.activated", 0, null);
      const e1 = await mk("grade_entry.created", 1, student);
      const e2 = await mk("attendance.recorded", 2, student);
      const e3 = await mk("grade_entry.created", 3, null);
      const e4 = await mk("note.created", 4, student);
      const d1 = deps(tx, { relaySettleSeconds: 0, relayBatchSize: 4 });
      const first = await createHandlers(d1).relayDomainEvents();
      const d2 = deps(tx, { relaySettleSeconds: 0, relayBatchSize: 50 });
      const second = await createHandlers(d2).relayDomainEvents();
      const [cursor] = await tx.$queryRaw<{ last_id: string }[]>`SELECT last_id::text FROM ssos_jobs.relay_cursor WHERE name = ${RELAY_CURSOR}`;
      return { student, ids: { ignored: ignored.id, e1: e1.id, e2: e2.id, e3: e3.id, e4: e4.id }, first, p1: d1.rec.published, p2: d2.rec.published, second, cursorAfterSecond: cursor!.last_id };
    });
    expect(r.first).toMatchObject({ scanned: 4, published: 3, skipped: 1, cursor: { id: r.ids.e4 } });
    expect(r.p1).toEqual([
      { topic: "student.graded", id: r.ids.e1, data: { tenantId: tenantA, studentPersonId: r.student, eventId: r.ids.e1, sourceType: "grade_entry.created" } },
      { topic: "attendance.marked", id: r.ids.e2, data: { tenantId: tenantA, studentPersonId: r.student, eventId: r.ids.e2, sourceType: "attendance.recorded" } },
      { topic: "note.created", id: r.ids.e4, data: { tenantId: tenantA, studentPersonId: r.student, eventId: r.ids.e4, sourceType: "note.created" } },
    ]);
    // The second run starts after e4: none of these events is published again.
    expect(r.p2.some((p) => Object.values(r.ids).includes(p.id))).toBe(false);
    expect(r.second.scanned).toBe(r.p2.length + r.second.skipped);
  });

  it("the settle window holds back events younger than it (a producer transaction may still commit earlier rows)", async () => {
    const r = await rolledBack(async (tx) => {
      const student = (await tx.person.findFirstOrThrow({ where: { tenantId: tenantA, externalRef: "S-001" } })).id;
      await setRelayCursor(tx, new Date(Date.now() - 60_000));
      const ev = await tx.event.create({ data: { tenantId: tenantA, type: "grade_entry.created", subjectPersonId: student }, select: { id: true } });
      const d = deps(tx, { relaySettleSeconds: 150 });
      const res = await createHandlers(d).relayDomainEvents();
      return { ev, res, published: d.rec.published };
    });
    expect(r.published.some((p) => p.id === r.ev.id)).toBe(false);
  });
});

// ─── Alerts, goals, nudges (slice 3b) ─────────────────────────────────────────

describe("jobs: alerts and goals ride on the student recompute", () => {
  it("student.graded opens alerts and records goal progress for the affected student only", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      const advisor = (await tx.roleAssignment.findFirstOrThrow({ where: { tenantId: tenantA, status: "active", role: { key: "advisor" } } })).personId;
      const goal = (s: string) => createGoal(tx, { tenantId: tenantA, studentPersonId: s, actorPersonId: advisor, title: "Lower risk", metric: "risk_score", target: 20, baseline: 90, deadline: "2027-03-01", now: AS_OF });
      const g0 = await goal(students[0]!);
      const g1 = await goal(students[1]!);
      const res = await createHandlers(deps(tx)).onStudentEvent("student.graded", { tenantId: tenantA, studentPersonId: students[0] });
      const alerts = await tx.alert.findMany({ where: { tenantId: tenantA }, include: { rule: { select: { key: true } } } });
      const progress = await tx.goalProgress.findMany({ where: { tenantId: tenantA } });
      return { students, res, alerts, progress, g0, g1 };
    });
    expect(r.res).toMatchObject({ status: "scored", score: 75, goals: { goals: 1, recorded: 1 } });
    // 75 crosses risk_high (>= 55) and risk_critical (>= 75): two alerts, both on the teacher rung.
    expect(r.alerts.map((a) => [a.rule.key, a.studentPersonId, a.state, a.assigneeRole]).sort()).toEqual([
      ["risk_critical", r.students[0], "open", "teacher"],
      ["risk_high", r.students[0], "open", "teacher"],
    ]);
    expect(r.progress.map((p) => [p.goalId, p.value.toNumber(), p.source])).toEqual([[r.g0.id, 75, "student.graded"]]);
  });

  it("the nightly tenant recompute also evaluates alerts and every active goal", async () => {
    const r = await rolledBack(async (tx) => {
      await cohortWithData(tx);
      return createHandlers(deps(tx)).recomputeTenant({ tenantId: tenantA });
    });
    expect(r).toMatchObject({ status: "recomputed", scored: 3, alerts: { opened: 2, resolved: 0 }, goals: { goals: 0 } });
  });
});

describe("jobs: escalation ladder (scheduled, every minute)", () => {
  it("escalateAlerts advances an alert only after its SLA elapsed: teacher -> advisor -> parent", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      await createHandlers(deps(tx)).onStudentEvent("student.graded", { tenantId: tenantA, studentPersonId: students[0] });
      const crit = await tx.alert.findFirstOrThrow({ where: { tenantId: tenantA, rule: { key: "risk_critical" } } });
      const due0 = crit.dueAt!.getTime();
      const at = (ms: number) => createHandlers(deps(tx, { now: () => new Date(ms) })).escalateAlerts();
      const mine = async (ms: number) => (await at(ms)).steps.filter((s) => s.alertId === crit.id).map((s) => `${s.action}:${s.fromRole}->${s.toRole}`);
      const MIN = 60_000;
      const out = {
        early: await mine(due0 - MIN), // 239 minutes after opening: nothing
        onTime: await mine(due0), // SLA (240 min) elapsed: teacher -> advisor
        sameMinute: await mine(due0 + 30_000),
        advisorEarly: await mine(due0 + 1440 * MIN - MIN),
        advisorDue: await mine(due0 + 1440 * MIN), // advisor SLA 1440 min elapsed -> parent
        parentDue: await mine(due0 + (1440 + 2880) * MIN),
        later: await mine(due0 + 90 * 24 * 60 * MIN),
      };
      const events = await tx.event.findMany({ where: { tenantId: tenantA, entityId: crit.id }, select: { type: true } });
      return { crit, out, events: events.map((e) => e.type).sort(), final: await tx.alert.findUniqueOrThrow({ where: { id: crit.id } }) };
    });
    expect(r.crit).toMatchObject({ state: "open", escalationLevel: 0, assigneeRole: "teacher" });
    expect(r.out).toEqual({
      early: [],
      onTime: ["escalated:teacher->advisor"],
      sameMinute: [],
      advisorEarly: [],
      advisorDue: ["escalated:advisor->parent"],
      parentDue: ["sla_expired:parent->parent"],
      later: [],
    });
    expect(r.final).toMatchObject({ state: "escalated", escalationLevel: 2, assigneeRole: "parent", dueAt: null });
    expect(r.events).toEqual(["alert.escalated", "alert.escalated", "alert.opened", "alert.sla_expired"]);
  });
});

describe("jobs: weekly goal nudges (scheduled daily, one per goal per ISO week)", () => {
  it("goalNudges run every day of a week sends each active goal exactly one nudge", async () => {
    const r = await rolledBack(async (tx) => {
      const students = await cohortWithData(tx);
      const advisor = (await tx.roleAssignment.findFirstOrThrow({ where: { tenantId: tenantA, status: "active", role: { key: "advisor" } } })).personId;
      for (const s of students.slice(0, 3)) await createGoal(tx, { tenantId: tenantA, studentPersonId: s, actorPersonId: advisor, title: "Attend", metric: "attendance_rate", target: 95, baseline: 70, deadline: "2027-03-01", now: AS_OF });
      const daily: number[] = [];
      for (let d = 0; d < 7; d++) daily.push((await createHandlers(deps(tx, { now: () => new Date(Date.UTC(2026, 11, 7 + d, 6)) })).goalNudges()).sent);
      const nextMonday = (await createHandlers(deps(tx, { now: () => new Date(Date.UTC(2026, 11, 14, 6)) })).goalNudges()).sent;
      const perGoalWeek = await tx.nudge.groupBy({ by: ["goalId", "weekStart"], where: { tenantId: tenantA }, _count: { _all: true } });
      return { daily, nextMonday, perGoalWeek };
    });
    expect(r.daily).toEqual([3, 0, 0, 0, 0, 0, 0]);
    expect(r.nextMonday).toBe(3);
    expect(r.perGoalWeek).toHaveLength(6);
    expect(r.perGoalWeek.every((g) => g._count._all === 1)).toBe(true);
  });
});
