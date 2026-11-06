/**
 * Success engine slice 3b — alerts, interventions, goals and nudges (service layer).
 *
 *  - alerts open from a new risk score against the tenant's rules, once per rule × student,
 *    and resolve when the score clears; acknowledgement stops the SLA timer;
 *  - escalation teacher → advisor → parent advances ONLY after the SLA has elapsed;
 *  - interventions from templates capture risk_before when opened and risk_after when closed;
 *  - SMART goals: validation, progress computed from the metric's data, achieved / missed;
 *  - exactly one nudge per goal per ISO week;
 *  - every mutation writes exactly one event.
 *
 * Each case runs inside a transaction that is rolled back (owner, or the app role via
 * withTenant), so the database is left exactly as seeded.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acknowledgeAlert, AlertError, crosses, escalateDueAlerts, evaluateRiskAlerts, parseLadder, parseThreshold, resolveAlert } from "../src/alerts";
import { createGoal, GoalError, goalProgressPct, measureGoalMetric, recomputeGoalProgress, sendWeeklyGoalNudges, setGoalStatus } from "../src/goals";
import { addInterventionTask, closeIntervention, createIntervention, deriveOutcome, INTERVENTION_TEMPLATES, InterventionError, setInterventionTaskStatus, startIntervention } from "../src/interventions";
import type { RiskScoreView } from "../src/risk-model";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A } from "./helpers";

type Tx = Prisma.TransactionClient;
const D = (v: number | string) => new Prisma.Decimal(v);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = new Date("2026-12-10T12:00:00Z"); // a Thursday

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

async function personWithRole(db: Tx, key: string): Promise<string> {
  const ra = await db.roleAssignment.findFirstOrThrow({ where: { tenantId: TENANT_A, status: "active", role: { key } }, select: { personId: true }, orderBy: { personId: "asc" } });
  return ra.personId;
}

/** A grade-10 student of tenant A with an active enrollment; helpers write their data. */
async function fixture(tx: Tx) {
  const term = await tx.term.findFirstOrThrow({ where: { tenantId: TENANT_A, startsOn: { lte: NOW }, endsOn: { gte: NOW } } });
  const enr = await tx.enrollment.findFirstOrThrow({
    where: { tenantId: TENANT_A, status: "active", classSection: { course: { grade: "10", academicYearId: term.academicYearId } } },
    select: { id: true, studentPersonId: true, classSection: { select: { courseId: true, course: { select: { gradeScale: true, assessmentCategories: { take: 1, orderBy: { name: "asc" } } } } } } },
    orderBy: [{ studentPersonId: "asc" }, { id: "asc" }],
  });
  const config = await tx.riskModelConfig.findFirstOrThrow({ where: { tenantId: TENANT_A, isActive: true } });
  const student = enr.studentPersonId;
  const c = enr.classSection.course;
  return {
    student,
    courseId: enr.classSection.courseId,
    /** A risk_score row for the student (engine-owned: owner only). */
    risk: async (score: number, at: Date = NOW): Promise<RiskScoreView> => {
      const band = score >= 75 ? "critical" : score >= 55 ? "high" : score >= 30 ? "moderate" : "low";
      const row = await tx.riskScore.create({
        data: { tenantId: TENANT_A, studentPersonId: student, modelConfigId: config.id, modelVersion: config.version, score: D(score), band, computedAt: at },
      });
      return { id: row.id, studentPersonId: student, modelConfigId: config.id, modelVersion: config.version, score, band, factors: [], cohortBaseline: {} as RiskScoreView["cohortBaseline"], computedAt: at };
    },
    attendance: (statuses: ("present" | "absent" | "late")[], firstDay: Date) =>
      tx.attendanceEvent.createMany({
        data: statuses.map((status, i) => ({ tenantId: TENANT_A, enrollmentId: enr.id, studentPersonId: student, date: new Date(firstDay.getTime() + i * DAY), status })),
      }),
    grades: (pcts: number[]) =>
      tx.gradeEntry.createMany({
        data: pcts.map((p, i) => ({
          tenantId: TENANT_A,
          enrollmentId: enr.id,
          assessmentCategoryId: c.assessmentCategories[0]!.id,
          termId: term.id,
          gradeScaleId: c.gradeScale!.id,
          rawMark: D(p).mul(c.gradeScale!.maxValue).div(100).toDecimalPlaces(2),
          gradedAt: new Date(Date.UTC(2026, 10, 2, 9) + i * MIN),
        })),
      }),
  };
}

/**
 * Event types written about an entity, SORTED: occurred_at is the transaction start, so
 * inside one rolled-back test transaction the order of the rows is not observable.
 */
const eventsFor = async (tx: Tx, entityId: string) => (await tx.event.findMany({ where: { tenantId: TENANT_A, entityId }, select: { type: true } })).map((e) => e.type).sort();
const sorted = (xs: string[]) => [...xs].sort();

// ─── Pure ─────────────────────────────────────────────────────────────────────

describe("alerts: rule parsing (pure)", () => {
  it("thresholds and ladders are validated; comparison is exact", () => {
    expect(parseThreshold({ op: "gte", value: 55 })).toEqual({ op: "gte", value: 55 });
    expect(parseThreshold({ op: "between", value: 55 })).toBeNull();
    expect(parseThreshold({ op: "gte", value: "55" })).toBeNull();
    expect(parseLadder([{ level: 1, role: "advisor", slaMinutes: 60 }, { level: 0, role: "teacher", slaMinutes: 30 }])!.map((s) => s.role)).toEqual(["teacher", "advisor"]);
    expect(parseLadder([])).toBeNull();
    expect(parseLadder([{ level: 0, role: "principal", slaMinutes: 30 }])).toBeNull();
    expect(parseLadder([{ level: 0, role: "teacher", slaMinutes: 0 }])).toBeNull();
    expect(crosses(55, { op: "gte", value: 55 })).toBe(true);
    expect(crosses(D("54.99"), { op: "gte", value: 55 })).toBe(false);
    expect(crosses(89.99, { op: "lte", value: 90 })).toBe(true);
    expect(crosses(90, { op: "lt", value: 90 })).toBe(false);
  });
});

describe("interventions + goals: outcome and progress rules (pure)", () => {
  it("outcome from risk before/after: ±5 points", () => {
    expect(deriveOutcome(70, 60)).toBe("improved");
    expect(deriveOutcome(70, 65)).toBe("improved");
    expect(deriveOutcome(70, 66)).toBe("no_change");
    expect(deriveOutcome(D("60.5"), D("65.5"))).toBe("worsened");
    expect(deriveOutcome(null, 50)).toBe("inconclusive");
    expect(deriveOutcome(50, null)).toBe("inconclusive");
  });
  it("progress % runs from baseline to target in the metric's direction, clamped 0–100", () => {
    expect(goalProgressPct("attendance_rate", 85, 95, 75).toNumber()).toBe(50);
    expect(goalProgressPct("attendance_rate", 70, 95, 75).toNumber()).toBe(0);
    expect(goalProgressPct("attendance_rate", 96, 95, 75).toNumber()).toBe(100);
    expect(goalProgressPct("risk_score", 50, 40, 70).toNumber()).toBe(66.67);
    expect(goalProgressPct("risk_score", 50, 40, null).toNumber()).toBe(0);
    expect(goalProgressPct("late_submissions", 0, 1, null).toNumber()).toBe(100);
  });
});

// ─── Alerts ───────────────────────────────────────────────────────────────────

describe("alerts: evaluated against a new risk score", () => {
  it("opens one alert per crossed rule (with ladder rung 0 and SLA due), never a duplicate, resolves when the score clears", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const s80 = await f.risk(80);
      const first = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: s80, now: NOW });
      const again = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(78), now: NOW });
      const mid = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(60), now: NOW });
      const low = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(20), now: NOW });
      const alerts = await tx.alert.findMany({ where: { tenantId: TENANT_A, studentPersonId: f.student }, include: { rule: true }, orderBy: { rule: { key: "asc" } } });
      const events = await Promise.all(alerts.map((a) => eventsFor(tx, a.id)));
      return { first, again, mid, low, alerts, events };
    });
    expect(r.first.opened).toHaveLength(2); // risk_critical (>= 75) and risk_high (>= 55)
    expect(r.again).toMatchObject({ opened: [], resolved: [], stillOpen: 2 });
    expect(r.mid.resolved).toHaveLength(1); // 60: critical clears, high stays
    expect(r.mid.stillOpen).toBe(1);
    expect(r.low.resolved).toHaveLength(1);
    expect(r.alerts.map((a) => [a.rule.key, a.state, a.assigneeRole, a.escalationLevel])).toEqual([
      ["risk_critical", "resolved", "teacher", 0],
      ["risk_high", "resolved", "teacher", 0],
    ]);
    const crit = r.alerts[0]!;
    expect(crit.severity).toBe("critical");
    expect(crit.triggeredAt.toISOString()).toBe(NOW.toISOString());
    expect(crit.trigger).toMatchObject({ metric: "risk_score", value: 80, op: "gte", threshold: 75 });
    // Exactly one event per mutation: opened, then resolved.
    expect(r.events).toEqual([sorted(["alert.opened", "alert.resolved"]), sorted(["alert.opened", "alert.resolved"])]);
  });

  it("a malformed rule is skipped and reported, never guessed", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      await tx.alertRule.update({ where: { tenantId_key: { tenantId: TENANT_A, key: "risk_high" } }, data: { threshold: { op: "nope", value: 1 } } });
      return evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(60), now: NOW });
    });
    expect(r).toMatchObject({ opened: [], invalidRules: ["risk_high"] });
  });
});

describe("alerts: escalation ladder teacher -> advisor -> parent on SLA minutes", () => {
  it("advances one rung only after the SLA has elapsed; the last rung's breach is recorded once", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const ev = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(80), now: NOW });
      const crit = await tx.alert.findFirstOrThrow({ where: { id: { in: ev.opened } , rule: { key: "risk_critical" } }, include: { rule: true } });
      const ladder = parseLadder(crit.rule.escalation)!; // 240 / 1440 / 2880 minutes
      const run = (at: Date) => escalateDueAlerts(tx, { tenantId: TENANT_A, now: at });
      const t0 = NOW.getTime();
      const sla0 = t0 + ladder[0]!.slaMinutes * MIN;
      const steps = {
        beforeSla0: await run(new Date(sla0 - MIN)),
        atSla0: await run(new Date(sla0)),
        rerun: await run(new Date(sla0)),
        state1: await tx.alert.findUniqueOrThrow({ where: { id: crit.id } }),
        beforeSla1: await run(new Date(sla0 + ladder[1]!.slaMinutes * MIN - MIN)),
        atSla1: await run(new Date(sla0 + ladder[1]!.slaMinutes * MIN)),
        state2: await tx.alert.findUniqueOrThrow({ where: { id: crit.id } }),
        atSla2: await run(new Date(sla0 + (ladder[1]!.slaMinutes + ladder[2]!.slaMinutes) * MIN)),
        after: await run(new Date(t0 + 30 * DAY)),
        final: await tx.alert.findUniqueOrThrow({ where: { id: crit.id } }),
      };
      return { ladder, crit, sla0, steps, events: await eventsFor(tx, crit.id) };
    });
    expect(r.ladder.map((s) => [s.role, s.slaMinutes])).toEqual([
      ["teacher", 240],
      ["advisor", 1440],
      ["parent", 2880],
    ]);
    expect(r.crit.dueAt!.getTime()).toBe(r.sla0);
    const critSteps = (x: { steps: { alertId: string; action: string; toRole: string }[] }) => x.steps.filter((s) => s.alertId === r.crit.id).map((s) => `${s.action}:${s.toRole}`);
    expect(critSteps(r.steps.beforeSla0)).toEqual([]);
    expect(critSteps(r.steps.atSla0)).toEqual(["escalated:advisor"]);
    expect(critSteps(r.steps.rerun)).toEqual([]);
    expect(r.steps.state1).toMatchObject({ state: "escalated", escalationLevel: 1, assigneeRole: "advisor" });
    expect(r.steps.state1.dueAt!.getTime()).toBe(r.sla0 + 1440 * MIN);
    expect(critSteps(r.steps.beforeSla1)).toEqual([]);
    expect(critSteps(r.steps.atSla1)).toEqual(["escalated:parent"]);
    expect(r.steps.state2).toMatchObject({ escalationLevel: 2, assigneeRole: "parent" });
    expect(critSteps(r.steps.atSla2)).toEqual(["sla_expired:parent"]);
    expect(critSteps(r.steps.after)).toEqual([]);
    expect(r.steps.final).toMatchObject({ state: "escalated", escalationLevel: 2, dueAt: null });
    expect(r.events).toEqual(sorted(["alert.opened", "alert.escalated", "alert.escalated", "alert.sla_expired"]));
  });

  it("an acknowledged alert stops its timer and never escalates; only roles on the ladder may acknowledge", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const ev = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(60), now: NOW });
      const alertId = ev.opened[0]!;
      const teacher = await personWithRole(tx, "teacher");
      const studentRole = f.student;
      const guardian = (await tx.guardianship.findFirstOrThrow({ where: { tenantId: TENANT_A, studentPersonId: f.student } })).guardianPersonId;
      const studentErr = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId, personId: studentRole, now: NOW }).catch((e: unknown) => e);
      const parentEarly = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId, personId: guardian, now: NOW }).catch((e: unknown) => e);
      const acked = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId, personId: teacher, note: "Talked to the student", now: new Date(NOW.getTime() + 10 * MIN) });
      const twice = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId, personId: teacher, now: NOW }).catch((e: unknown) => e);
      const esc = await escalateDueAlerts(tx, { tenantId: TENANT_A, now: new Date(NOW.getTime() + 60 * DAY) });
      const resolved = await resolveAlert(tx, { tenantId: TENANT_A, alertId, personId: teacher, now: new Date(NOW.getTime() + DAY) });
      return { studentErr, parentEarly, acked, twice, esc, resolved, events: await eventsFor(tx, alertId), teacher };
    });
    expect(r.studentErr).toBeInstanceOf(AlertError);
    expect((r.studentErr as AlertError).code).toBe("not_authorized");
    expect((r.parentEarly as AlertError).code).toBe("not_authorized"); // the ladder has not reached parent
    expect(r.acked).toMatchObject({ state: "acknowledged", dueAt: null });
    expect(r.acked.acknowledgements).toEqual([{ personId: r.teacher, role: "teacher", at: new Date(NOW.getTime() + 10 * MIN).toISOString(), level: 0, note: "Talked to the student" }]);
    expect((r.twice as AlertError).code).toBe("invalid_state");
    expect(r.esc.steps).toEqual([]);
    expect(r.resolved.state).toBe("resolved");
    expect(r.events).toEqual(sorted(["alert.opened", "alert.acknowledged", "alert.resolved"]));
  });

  it("once the ladder reaches parent, a guardian of the student may acknowledge (app role, RLS)", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const ev = await evaluateRiskAlerts(tx, { tenantId: TENANT_A, riskScore: await f.risk(60), now: NOW });
      // risk_high ladder: 2880 / 4320 minutes to reach parent.
      await escalateDueAlerts(tx, { tenantId: TENANT_A, now: new Date(NOW.getTime() + 2 * DAY) });
      await escalateDueAlerts(tx, { tenantId: TENANT_A, now: new Date(NOW.getTime() + 5 * DAY) });
      const guardian = (await tx.guardianship.findFirstOrThrow({ where: { tenantId: TENANT_A, studentPersonId: f.student } })).guardianPersonId;
      const otherGuardian = (await tx.guardianship.findFirstOrThrow({ where: { tenantId: TENANT_A, studentPersonId: { not: f.student }, guardianPersonId: { not: guardian } } })).guardianPersonId;
      const stranger = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId: ev.opened[0]!, personId: otherGuardian, now: NOW }).catch((e: unknown) => e);
      const acked = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId: ev.opened[0]!, personId: guardian, now: NOW });
      return { stranger, acked };
    });
    expect((r.stranger as AlertError).code).toBe("not_authorized");
    expect(r.acked).toMatchObject({ state: "acknowledged", escalationLevel: 2, assigneeRole: "parent" });
  });

  it("works on the app role inside withTenant (alerts are tenant tables)", async () => {
    const r = await rolledBack("app", async (tx) => {
      const rule = await tx.alertRule.findFirstOrThrow({ where: { tenantId: TENANT_A, key: "risk_high" } });
      const student = (await tx.enrollment.findFirstOrThrow({ where: { tenantId: TENANT_A, status: "active" } })).studentPersonId;
      const a = await tx.alert.create({ data: { tenantId: TENANT_A, ruleId: rule.id, studentPersonId: student, severity: "warning", assigneeRole: "teacher", dueAt: new Date(NOW.getTime() - MIN) } });
      const esc = await escalateDueAlerts(tx, { tenantId: TENANT_A, now: NOW });
      const advisor = await personWithRole(tx, "advisor");
      const acked = await acknowledgeAlert(tx, { tenantId: TENANT_A, alertId: a.id, personId: advisor, now: NOW });
      return { esc, acked, events: await eventsFor(tx, a.id) };
    });
    expect(r.esc.escalated).toBe(1);
    expect(r.acked.state).toBe("acknowledged");
    expect(r.events).toEqual(sorted(["alert.escalated", "alert.acknowledged"]));
  });
});

// ─── Interventions ────────────────────────────────────────────────────────────

describe("interventions: templates, tasks, status and outcome capture", () => {
  it("captures risk_before when opened and risk_after when closed; outcome derived from the change", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const advisor = await personWithRole(tx, "advisor");
      await f.risk(72, new Date(NOW.getTime() - 2 * DAY));
      const opened = await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, templateKey: "academic_tutoring", actorPersonId: advisor, startOn: "2026-12-14", now: NOW });
      const tasks = await tx.interventionTask.findMany({ where: { interventionId: opened.intervention.id }, orderBy: { sequence: "asc" } });
      const started = await startIntervention(tx, { tenantId: TENANT_A, interventionId: opened.intervention.id, actorPersonId: advisor, startOn: "2026-12-14", now: NOW });
      const extra = await addInterventionTask(tx, { tenantId: TENANT_A, interventionId: opened.intervention.id, actorPersonId: advisor, title: "Call home", dueOn: "2026-12-20", now: NOW });
      const done = await setInterventionTaskStatus(tx, { tenantId: TENANT_A, taskId: tasks[0]!.id, status: "done", actorPersonId: advisor, now: NOW });
      // The risk model scores the student again later — the newer score is what closing captures.
      await f.risk(58.5, new Date(NOW.getTime() + 30 * DAY));
      const closed = await closeIntervention(tx, { tenantId: TENANT_A, interventionId: opened.intervention.id, actorPersonId: advisor, outcomeNote: "Grades up", endedOn: "2027-01-25", now: new Date(NOW.getTime() + 45 * DAY) });
      const again = await closeIntervention(tx, { tenantId: TENANT_A, interventionId: opened.intervention.id, actorPersonId: advisor, now: NOW }).catch((e: unknown) => e);
      const events = await tx.event.findMany({ where: { tenantId: TENANT_A, entityId: { in: [opened.intervention.id, ...tasks.map((t) => t.id), extra.id] } } });
      return { opened, tasks, started, extra, done, closed, again, events };
    });
    expect(r.opened.intervention).toMatchObject({ templateKey: "academic_tutoring", type: "academic_tutoring", severity: "medium", status: "planned" });
    expect(r.opened.intervention.riskBefore!.toString()).toBe("72");
    expect(r.opened.intervention.riskAfter).toBeNull();
    // Template tasks: tenant A's default locale is sq; due = start + offset.
    expect(r.tasks.map((t) => [t.sequence, t.title, t.dueOn!.toISOString().slice(0, 10)])).toEqual(
      INTERVENTION_TEMPLATES.academic_tutoring!.tasks.map((t, i) => [i + 1, t.title.sq, new Date(Date.UTC(2026, 11, 14) + t.offsetDays * DAY).toISOString().slice(0, 10)]),
    );
    expect(r.started).toMatchObject({ status: "active" });
    expect(r.extra.sequence).toBe(5);
    expect(r.done.status).toBe("done");
    expect(r.done.completedAt).not.toBeNull();
    expect(r.closed).toMatchObject({ status: "completed", outcome: "improved", outcomeNote: "Grades up" });
    expect(r.closed.riskBefore!.toString()).toBe("72");
    expect(r.closed.riskAfter!.toString()).toBe("58.5");
    expect(r.again).toBeInstanceOf(InterventionError);
    expect((r.again as InterventionError).code).toBe("invalid_state");
    // One event per mutation.
    expect(sorted(r.events.map((e) => e.type))).toEqual(sorted(["intervention.created", "intervention.started", "intervention_task.created", "intervention_task.updated", "intervention.completed"]));
    expect(r.events.find((e) => e.type === "intervention.completed")!.payload).toMatchObject({ riskBefore: 72, riskAfter: 58.5, riskChange: -13.5, outcome: "improved", derivedOutcome: "improved" });
  });

  it("explicit outcome wins; cancelled keeps risk_after; no score -> inconclusive; validation errors write nothing", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const teacher = await personWithRole(tx, "teacher");
      const adHoc = await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, type: "peer_support", tasks: [{ title: "Pair with a buddy" }], actorPersonId: teacher, start: true, now: NOW });
      const noScore = await closeIntervention(tx, { tenantId: TENANT_A, interventionId: adHoc.intervention.id, actorPersonId: teacher, now: NOW });
      await f.risk(40);
      const iv2 = await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, templateKey: "mentoring", actorPersonId: teacher, now: NOW });
      await f.risk(41, new Date(NOW.getTime() + MIN));
      const cancelled = await closeIntervention(tx, { tenantId: TENANT_A, interventionId: iv2.intervention.id, status: "cancelled", actorPersonId: teacher, now: NOW });
      const iv3 = await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, templateKey: "family_meeting", actorPersonId: teacher, now: NOW });
      const explicit = await closeIntervention(tx, { tenantId: TENANT_A, interventionId: iv3.intervention.id, outcome: "worsened", actorPersonId: teacher, now: NOW });
      const before = await tx.intervention.count({ where: { tenantId: TENANT_A } });
      const errors = [
        await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, templateKey: "nope", actorPersonId: teacher, now: NOW }).catch((e: unknown) => e),
        await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, templateKey: "mentoring", actorPersonId: f.student, now: NOW }).catch((e: unknown) => e),
        await createIntervention(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, now: NOW }).catch((e: unknown) => e),
      ];
      return { adHoc, noScore, cancelled, explicit, errors, before, after: await tx.intervention.count({ where: { tenantId: TENANT_A } }) };
    });
    expect(r.adHoc.intervention).toMatchObject({ status: "active", templateKey: null, type: "peer_support", riskBefore: null });
    expect(r.adHoc.tasks).toBe(1);
    expect(r.noScore).toMatchObject({ outcome: "inconclusive", riskAfter: null });
    expect(r.cancelled).toMatchObject({ status: "cancelled", outcome: null });
    expect(r.cancelled.riskBefore!.toNumber()).toBe(40);
    expect(r.cancelled.riskAfter!.toNumber()).toBe(41);
    expect(r.explicit.outcome).toBe("worsened");
    expect(r.errors.map((e) => (e as InterventionError).code)).toEqual(["unknown_template", "not_authorized", "invalid_input"]);
    expect(r.after).toBe(r.before);
  });
});

// ─── Goals ────────────────────────────────────────────────────────────────────

describe("goals: SMART validation and computed progress", () => {
  it("rejects goals that are not specific, measurable, achievable or time-bound", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const advisor = await personWithRole(tx, "advisor");
      const base = { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: advisor, title: "Attend every lesson", metric: "attendance_rate", target: 95, deadline: "2027-02-01", baseline: 80, now: NOW };
      const parent = (await tx.guardianship.findFirstOrThrow({ where: { tenantId: TENANT_A, studentPersonId: { not: f.student } } })).guardianPersonId;
      const tries = [
        { title: "x" },
        { metric: "happiness" },
        { target: 120 },
        { baseline: 96 }, // already met
        { deadline: "2026-12-10" }, // not in the future
        { deadline: "2028-06-01" }, // beyond a year
        { metricParams: { windowDays: 0 } },
        { metric: "risk_score", metricParams: { courseId: f.courseId } },
        { actorPersonId: parent },
      ];
      const codes: string[] = [];
      for (const t of tries) codes.push(await createGoal(tx, { ...base, ...t }).then(() => "ok", (e: unknown) => (e instanceof GoalError ? e.code : `not a GoalError: ${String(e)}`)));
      return { codes, goals: await tx.goal.count({ where: { tenantId: TENANT_A } }) };
    });
    expect(r.codes).toEqual(["invalid_input", "invalid_metric", "invalid_target", "invalid_target", "invalid_deadline", "invalid_deadline", "invalid_metric", "invalid_metric", "not_authorized"]);
    expect(r.goals).toBe(0);
  });

  it("baseline measured from data; progress recorded only when the value moves; achieved when met; one event each", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      // Last 30 days before NOW: 3 present, 1 absent -> 75%.
      await f.attendance(["present", "absent", "present", "present"], new Date(Date.UTC(2026, 11, 1)));
      const goal = await createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: f.student, title: "Come to school every day", metric: "attendance_rate", metricParams: { courseId: f.courseId }, target: 90, deadline: "2027-01-31", now: NOW });
      const p1 = await recomputeGoalProgress(tx, { tenantId: TENANT_A, studentPersonId: f.student, source: "attendance.marked", now: NOW });
      const p2 = await recomputeGoalProgress(tx, { tenantId: TENANT_A, studentPersonId: f.student, source: "attendance.marked", now: NOW });
      // Four more present days -> 7/8 = 87.5% -> (87.5-75)/(90-75) = 83.33%.
      const later = new Date(Date.UTC(2026, 11, 12, 12));
      await f.attendance(["present", "present", "present", "present"], new Date(Date.UTC(2026, 11, 5)));
      const p3 = await recomputeGoalProgress(tx, { tenantId: TENANT_A, studentPersonId: f.student, source: "attendance.marked", now: later });
      await f.attendance(["present", "present", "present", "present", "present", "present", "present"], new Date(Date.UTC(2026, 11, 9)));
      const p4 = await recomputeGoalProgress(tx, { tenantId: TENANT_A, source: "nightly", now: new Date(Date.UTC(2026, 11, 16, 12)) });
      const samples = await tx.goalProgress.findMany({ where: { goalId: goal.id }, orderBy: { measuredAt: "asc" } });
      return { goal, p1, p2, p3, p4, samples, final: await tx.goal.findUniqueOrThrow({ where: { id: goal.id } }), events: await eventsFor(tx, goal.id) };
    });
    expect(r.goal.baseline!.toNumber()).toBe(75);
    expect(r.p1).toMatchObject({ goals: 1, recorded: 1 });
    expect(r.p2).toMatchObject({ goals: 1, recorded: 0, unchanged: 1 });
    expect(r.p3).toMatchObject({ recorded: 1 });
    expect(r.p4).toMatchObject({ recorded: 1, achieved: 1 });
    expect(r.samples.map((s) => [s.value.toNumber(), s.progressPct.toNumber(), s.source])).toEqual([
      [75, 0, "attendance.marked"],
      [87.5, 83.33, "attendance.marked"],
      [93.33, 100, "nightly"],
    ]);
    expect(r.final.status).toBe("achieved");
    expect(r.events).toEqual(sorted(["goal.created", "goal.progress_recorded", "goal.progress_recorded", "goal.progress_recorded"]));
  });

  it("a goal not met by its deadline becomes missed; course_average and risk_score metrics read the student's data", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const teacher = await personWithRole(tx, "teacher");
      await f.grades([60, 70]);
      await f.risk(64);
      const avg = await measureGoalMetric(tx, { tenantId: TENANT_A, studentPersonId: f.student, metric: "course_average", params: { courseId: f.courseId }, now: NOW });
      const risk = await measureGoalMetric(tx, { tenantId: TENANT_A, studentPersonId: f.student, metric: "risk_score", now: NOW });
      const g = await createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, title: "Lower my risk", metric: "risk_score", target: 40, deadline: "2026-12-20", now: NOW });
      const draft = await createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, title: "Raise my average", metric: "course_average", target: 80, deadline: "2027-03-01", status: "draft", now: NOW });
      const res = await recomputeGoalProgress(tx, { tenantId: TENANT_A, studentPersonId: f.student, now: new Date(Date.UTC(2026, 11, 21, 8)) });
      const activated = await setGoalStatus(tx, { tenantId: TENANT_A, goalId: draft.id, status: "active", actorPersonId: f.student, now: NOW });
      return { avg, risk, g, res, final: await tx.goal.findUniqueOrThrow({ where: { id: g.id } }), activated, events: await eventsFor(tx, g.id) };
    });
    expect(r.avg!.toNumber()).toBe(65);
    expect(r.risk!.toNumber()).toBe(64);
    expect(r.g.baseline!.toNumber()).toBe(64);
    expect(r.res).toMatchObject({ goals: 1, missed: 1 }); // the draft is not active
    expect(r.final.status).toBe("missed");
    expect(r.activated.status).toBe("active");
    expect(r.events).toEqual(sorted(["goal.created", "goal.progress_recorded"]));
  });
});

// ─── Nudges ───────────────────────────────────────────────────────────────────

describe("nudges: exactly one per goal per week", () => {
  it("any number of runs in a week sends one nudge per active goal; the next week sends the next one", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const teacher = await personWithRole(tx, "teacher");
      const mk = (title: string) => createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, title, metric: "attendance_rate", target: 95, baseline: 80, deadline: "2027-03-01", now: NOW });
      const g1 = await mk("Goal one");
      const g2 = await mk("Goal two");
      const cancelled = await mk("Goal three");
      await setGoalStatus(tx, { tenantId: TENANT_A, goalId: cancelled.id, status: "cancelled", actorPersonId: teacher, now: NOW });
      const run = (iso: string) => sendWeeklyGoalNudges(tx, { tenantId: TENANT_A, now: new Date(iso) });
      const runs = [
        await run("2026-12-07T06:00:00Z"), // Monday
        await run("2026-12-07T06:00:00Z"),
        await run("2026-12-10T06:00:00Z"), // Thursday
        await run("2026-12-13T21:00:00Z"), // Sunday 22:00 in Tirana — same week
        await run("2026-12-14T06:00:00Z"), // next Monday
      ];
      const nudges = await tx.nudge.findMany({ where: { tenantId: TENANT_A }, orderBy: [{ weekStart: "asc" }, { goalId: "asc" }] });
      const events = await tx.event.findMany({ where: { tenantId: TENANT_A, type: "nudge.sent" } });
      return { g1, g2, cancelled, runs, nudges, events };
    });
    expect(r.runs.map((x) => [x.sent, x.alreadyNudged])).toEqual([
      [2, 0],
      [0, 2],
      [0, 2],
      [0, 2],
      [2, 0],
    ]);
    expect(r.nudges.map((n) => n.weekStart.toISOString().slice(0, 10))).toEqual(["2026-12-07", "2026-12-07", "2026-12-14", "2026-12-14"]);
    expect(new Set(r.nudges.map((n) => n.goalId))).toEqual(new Set([r.g1.id, r.g2.id]));
    expect(r.nudges.every((n) => n.recipientPersonId === r.g1.studentPersonId && n.status === "sent" && n.channel === "in_app")).toBe(true);
    expect(r.nudges[0]!.payload).toMatchObject({ messageKey: "success.nudge.goalWeekly", params: { target: 95 } });
    expect(r.events).toHaveLength(4); // one event per nudge
  });

  it("the week follows the tenant's time zone (Monday 00:30 in Tirana is already the new week)", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const teacher = await personWithRole(tx, "teacher");
      await createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, title: "Goal", metric: "attendance_rate", target: 95, baseline: 80, deadline: "2027-03-01", now: NOW });
      await sendWeeklyGoalNudges(tx, { tenantId: TENANT_A, now: new Date("2026-12-13T23:30:00Z") }); // Mon 00:30 CET
      return tx.nudge.findMany({ where: { tenantId: TENANT_A } });
    });
    expect(r.map((n) => n.weekStart.toISOString().slice(0, 10))).toEqual(["2026-12-14"]);
  });

  it("the database itself refuses a second nudge for the same goal and week", async () => {
    const r = await rolledBack("owner", async (tx) => {
      const f = await fixture(tx);
      const teacher = await personWithRole(tx, "teacher");
      const g = await createGoal(tx, { tenantId: TENANT_A, studentPersonId: f.student, actorPersonId: teacher, title: "Goal", metric: "attendance_rate", target: 95, baseline: 80, deadline: "2027-03-01", now: NOW });
      const row = { tenantId: TENANT_A, goalId: g.id, recipientPersonId: f.student, weekStart: new Date("2026-12-07T00:00:00Z"), scheduledFor: NOW };
      await tx.nudge.create({ data: row });
      await tx.$executeRaw`SAVEPOINT dup`;
      const err = await tx.nudge.create({ data: row }).catch((e: unknown) => e);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT dup`;
      return err;
    });
    expect((r as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
  });
});
