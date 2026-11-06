/**
 * SMART goals and weekly nudges (success engine slice 3b). Service layer only.
 *
 * A goal is Specific (a title), Measurable (a metric from GOAL_METRICS computed from the
 * student's own data), Achievable (a target inside the metric's range and better than the
 * baseline), Relevant (about one student, optionally tied to an intervention) and
 * Time-bound (a deadline within a year). createGoal rejects anything else.
 *
 * Progress is COMPUTED, never typed in: recomputeGoalProgress measures the metric for the
 * student's active goals and writes a goal_progress sample (value, progress % from baseline
 * towards target) when the value moved; the goal becomes `achieved` when the target is met
 * and `missed` once the deadline has passed without it. It runs from the @ssos/jobs student
 * subscribers (affected student only) and the nightly tenant recompute.
 *
 * Nudges: sendWeeklyGoalNudges gives every active goal exactly ONE nudge per ISO week (the
 * week of the tenant's local date; `nudge` is unique on (goal, week_start) and week_start
 * must be a Monday) — the job may run any number of times a week.
 *
 * Every mutation writes exactly one `event` row in the same transaction:
 * goal.created | goal.activated | goal.cancelled | goal.progress_recorded | goal.achieved | goal.missed |
 * nudge.sent.
 * Works on the owner client or the app role inside `withTenant`.
 */
import { Prisma, type GoalStatus, type PrismaClient } from "@prisma/client";

import { type Db, DAY_MS, dateOnly, findPerson, hasActiveRole, inTx, isoDate, isoWeekStart, isUuid, latestRisk, localDate, parseIsoDate, STAFF_ROLES } from "./success-common";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

// ─── Errors ──────────────────────────────────────────────────────────────────

export type GoalErrorCode =
  | "unknown_goal"
  | "unknown_student"
  | "unknown_person"
  | "unknown_intervention"
  | "not_authorized"
  | "invalid_state"
  | "invalid_input"
  | "invalid_metric"
  | "invalid_target"
  | "invalid_deadline";

export class GoalError extends Error {
  readonly code: GoalErrorCode;
  constructor(code: GoalErrorCode, message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface GoalMetricDef {
  /** higher: the value should go up to the target; lower: down to it. */
  direction: "higher" | "lower";
  min: number;
  max: number;
  /** Default look-back window (days) for windowed metrics; null = current academic year / latest. */
  defaultWindowDays: number | null;
  /** Accepts metricParams.courseId. */
  courseScoped: boolean;
}

/** Product definitions — identical for every tenant and country. */
export const GOAL_METRICS = {
  /** (present + late) / all marks × 100 over the window — the attendance_rate formula. */
  attendance_rate: { direction: "higher", min: 0, max: 100, defaultWindowDays: 30, courseScoped: true },
  /** Mean grade-entry percentage this academic year (mean per enrollment, then across). */
  course_average: { direction: "higher", min: 0, max: 100, defaultWindowDays: null, courseScoped: true },
  /** Submissions handed in late within the window. */
  late_submissions: { direction: "lower", min: 0, max: 1000, defaultWindowDays: 14, courseScoped: false },
  /** The student's latest risk score (0–100). */
  risk_score: { direction: "lower", min: 0, max: 100, defaultWindowDays: null, courseScoped: false },
} as const satisfies Record<string, GoalMetricDef>;

export type GoalMetric = keyof typeof GOAL_METRICS;
export const isGoalMetric = (m: unknown): m is GoalMetric => typeof m === "string" && Object.prototype.hasOwnProperty.call(GOAL_METRICS, m);

export interface GoalMetricParams {
  courseId?: string;
  windowDays?: number;
}

export const GOAL_RULES = {
  /** Latest allowed deadline, days after creation. */
  maxHorizonDays: 366,
  titleMin: 3,
  titleMax: 200,
} as const;

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const mean = (xs: Decimal[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a.plus(b), ZERO).div(xs.length));

/** Pure: is the target met by this value? */
export function goalMet(metric: GoalMetric, value: Decimal | number, target: Decimal | number): boolean {
  const v = new Decimal(value);
  return GOAL_METRICS[metric].direction === "higher" ? v.gte(target) : v.lte(target);
}

/**
 * Pure: progress 0–100 (2 dp) from baseline towards target. Without a usable baseline
 * (none, or equal to the target) it is 100 when met and 0 otherwise.
 */
export function goalProgressPct(metric: GoalMetric, value: Decimal | number, target: Decimal | number, baseline: Decimal | number | null): Decimal {
  const v = new Decimal(value);
  const t = new Decimal(target);
  if (goalMet(metric, v, t)) return new Decimal(100);
  if (baseline === null || t.eq(baseline)) return new Decimal(0);
  const pct = v.minus(baseline).div(t.minus(baseline)).mul(100);
  return round2(Decimal.max(ZERO, Decimal.min(HUNDRED, pct)));
}

function parseParams(metric: GoalMetric, raw: unknown): GoalMetricParams {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new GoalError("invalid_metric", "metricParams must be an object");
  const o = raw as Record<string, unknown>;
  const out: GoalMetricParams = {};
  for (const k of Object.keys(o)) if (k !== "courseId" && k !== "windowDays") throw new GoalError("invalid_metric", `unknown metric parameter "${k}"`);
  if (o.courseId !== undefined) {
    if (!GOAL_METRICS[metric].courseScoped) throw new GoalError("invalid_metric", `${metric} does not take a courseId`);
    if (!isUuid(o.courseId)) throw new GoalError("invalid_metric", "courseId must be a uuid");
    out.courseId = o.courseId;
  }
  if (o.windowDays !== undefined) {
    if (GOAL_METRICS[metric].defaultWindowDays === null) throw new GoalError("invalid_metric", `${metric} does not take a windowDays`);
    if (typeof o.windowDays !== "number" || !Number.isInteger(o.windowDays) || o.windowDays < 1 || o.windowDays > 365) throw new GoalError("invalid_metric", "windowDays must be an integer 1–365");
    out.windowDays = o.windowDays;
  }
  return out;
}

async function currentYear(db: PrismaClient | Db, tenantId: string, at: Date) {
  const flagged = await db.academicYear.findFirst({ where: { tenantId, isCurrent: true }, select: { id: true, startsOn: true } });
  if (flagged) return flagged;
  return db.academicYear.findFirst({ where: { tenantId, startsOn: { lte: at }, endsOn: { gte: at } }, select: { id: true, startsOn: true } });
}

/** Measure a goal metric for one student at `now` (exact decimal, 2 dp); null = no data yet. */
export async function measureGoalMetric(db: PrismaClient | Db, input: { tenantId: string; studentPersonId: string; metric: GoalMetric; params?: GoalMetricParams; now?: Date }): Promise<Decimal | null> {
  const { tenantId, studentPersonId, metric } = input;
  const params = input.params ?? {};
  const now = input.now ?? new Date();
  const def: GoalMetricDef = GOAL_METRICS[metric];
  const windowStart = def.defaultWindowDays !== null ? new Date(now.getTime() - (params.windowDays ?? def.defaultWindowDays) * DAY_MS) : null;

  if (metric === "risk_score") {
    const r = await latestRisk(db, tenantId, studentPersonId);
    return r ? r.score : null;
  }
  if (metric === "late_submissions") {
    const n = await db.submission.count({ where: { tenantId, studentPersonId, isLate: true, submittedAt: { gt: windowStart!, lte: now } } });
    return new Decimal(n);
  }
  const year = await currentYear(db, tenantId, now);
  if (!year) return null;
  const enrollments = await db.enrollment.findMany({
    where: { tenantId, studentPersonId, status: "active", classSection: { course: { academicYearId: year.id, ...(params.courseId ? { id: params.courseId } : {}) } } },
    select: { id: true },
  });
  if (enrollments.length === 0) return null;
  const enrollmentIds = enrollments.map((e) => e.id);
  if (metric === "attendance_rate") {
    const marks = await db.attendanceEvent.groupBy({
      by: ["status"],
      where: { tenantId, studentPersonId, enrollmentId: { in: enrollmentIds }, date: { gt: dateOnly(windowStart!), lte: now } },
      _count: { _all: true },
    });
    const total = marks.reduce((a, m) => a + m._count._all, 0);
    if (total === 0) return null;
    const attended = marks.filter((m) => m.status === "present" || m.status === "late").reduce((a, m) => a + m._count._all, 0);
    return round2(new Decimal(attended).div(total).mul(100));
  }
  // course_average
  const entries = await db.gradeEntry.findMany({
    where: { tenantId, enrollmentId: { in: enrollmentIds }, term: { academicYearId: year.id }, gradedAt: { lte: now } },
    select: { enrollmentId: true, rawMark: true, gradeScale: { select: { maxValue: true } } },
  });
  const byEnrollment = new Map<string, Decimal[]>();
  for (const e of entries) byEnrollment.set(e.enrollmentId, [...(byEnrollment.get(e.enrollmentId) ?? []), e.rawMark.div(e.gradeScale.maxValue).mul(100)]);
  const m = mean([...byEnrollment.values()].map((xs) => mean(xs)!));
  return m === null ? null : round2(m);
}

// ─── Create / status ─────────────────────────────────────────────────────────

export interface CreateGoalInput {
  tenantId: string;
  studentPersonId: string;
  title: string;
  metric: string;
  metricParams?: GoalMetricParams;
  target: number | string;
  /** YYYY-MM-DD. */
  deadline: string;
  /** Default: the metric measured now (null when there is no data yet). */
  baseline?: number | string | null;
  interventionId?: string | null;
  /** Staff (teacher, advisor, admin) or the student themself. */
  actorPersonId: string;
  actorUserId?: string | null;
  /** active (default) or draft. */
  status?: "active" | "draft";
  now?: Date;
}

/** Create a SMART goal. One event `goal.created`. */
export function createGoal(db: PrismaClient | Db, input: CreateGoalInput) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const actor = await findPerson(tx, tenantId, input.actorPersonId);
    if (!actor) throw new GoalError("unknown_person", `person ${input.actorPersonId} not found in tenant`);
    const student = await findPerson(tx, tenantId, input.studentPersonId);
    if (!student) throw new GoalError("unknown_student", `student ${input.studentPersonId} not found in tenant`);
    if (actor.id !== student.id && !(await hasActiveRole(tx, tenantId, actor.id, STAFF_ROLES, now)))
      throw new GoalError("not_authorized", "a goal is set by staff or by the student themself");

    // Specific
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length < GOAL_RULES.titleMin || title.length > GOAL_RULES.titleMax) throw new GoalError("invalid_input", `title must be ${GOAL_RULES.titleMin}–${GOAL_RULES.titleMax} characters`);
    // Measurable
    if (!isGoalMetric(input.metric)) throw new GoalError("invalid_metric", `metric must be one of ${Object.keys(GOAL_METRICS).join(", ")}`);
    const metric = input.metric;
    const params = parseParams(metric, input.metricParams);
    if (params.courseId) {
      const enrolled = await tx.enrollment.findFirst({ where: { tenantId, studentPersonId: student.id, status: "active", classSection: { courseId: params.courseId } }, select: { id: true } });
      if (!enrolled) throw new GoalError("invalid_metric", "the student is not enrolled in that course");
    }
    // Achievable
    const def = GOAL_METRICS[metric];
    let target: Decimal;
    try {
      target = new Decimal(input.target);
    } catch {
      throw new GoalError("invalid_target", "target must be a number");
    }
    if (!target.isFinite() || target.lt(def.min) || target.gt(def.max)) throw new GoalError("invalid_target", `target must be between ${def.min} and ${def.max}`);
    let baseline: Decimal | null;
    if (input.baseline !== undefined && input.baseline !== null) {
      try {
        baseline = new Decimal(input.baseline);
      } catch {
        throw new GoalError("invalid_input", "baseline must be a number");
      }
      if (!baseline.isFinite() || baseline.lt(def.min) || baseline.gt(def.max)) throw new GoalError("invalid_input", `baseline must be between ${def.min} and ${def.max}`);
    } else {
      baseline = await measureGoalMetric(tx, { tenantId, studentPersonId: student.id, metric, params, now });
    }
    if (baseline !== null && goalMet(metric, baseline, target)) throw new GoalError("invalid_target", `the target is already met (baseline ${baseline.toString()})`);
    // Time-bound
    const deadline = parseIsoDate(input.deadline);
    if (!deadline) throw new GoalError("invalid_deadline", "deadline must be a YYYY-MM-DD date");
    const today = dateOnly(now);
    if (deadline <= today) throw new GoalError("invalid_deadline", "deadline must be in the future");
    if (deadline.getTime() > today.getTime() + GOAL_RULES.maxHorizonDays * DAY_MS) throw new GoalError("invalid_deadline", `deadline must be within ${GOAL_RULES.maxHorizonDays} days`);
    // Relevant
    if (input.interventionId) {
      const iv = isUuid(input.interventionId) ? await tx.intervention.findFirst({ where: { tenantId, id: input.interventionId }, select: { studentPersonId: true } }) : null;
      if (!iv || iv.studentPersonId !== student.id) throw new GoalError("unknown_intervention", `intervention ${input.interventionId} not found for this student`);
    }
    const status = input.status ?? "active";
    if (status !== "active" && status !== "draft") throw new GoalError("invalid_input", "status must be active or draft");

    const goal = await tx.goal.create({
      data: {
        tenantId,
        studentPersonId: student.id,
        title,
        metric,
        metricParams: { ...params },
        baseline,
        target,
        deadline,
        status,
        interventionId: input.interventionId ?? null,
        createdByPersonId: actor.id,
      },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: "goal.created",
        actorPersonId: actor.id,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: student.id,
        entityType: "goal",
        entityId: goal.id,
        payload: { metric, metricParams: { ...params }, baseline: baseline?.toNumber() ?? null, target: target.toNumber(), deadline: isoDate(deadline), status },
      },
    });
    return goal;
  });
}

/** draft → active, or draft|active → cancelled. One event `goal.activated` / `goal.cancelled`. */
export function setGoalStatus(db: PrismaClient | Db, input: { tenantId: string; goalId: string; status: "active" | "cancelled"; actorPersonId: string; actorUserId?: string | null; now?: Date }) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const goal = isUuid(input.goalId) ? await tx.goal.findFirst({ where: { tenantId, id: input.goalId } }) : null;
    if (!goal) throw new GoalError("unknown_goal", `goal ${input.goalId} not found in tenant`);
    const actor = await findPerson(tx, tenantId, input.actorPersonId);
    if (!actor) throw new GoalError("unknown_person", `person ${input.actorPersonId} not found in tenant`);
    if (actor.id !== goal.studentPersonId && !(await hasActiveRole(tx, tenantId, actor.id, STAFF_ROLES, now))) throw new GoalError("not_authorized", "only staff or the student may change a goal");
    const allowed = input.status === "active" ? goal.status === "draft" : goal.status === "draft" || goal.status === "active";
    if (!allowed) throw new GoalError("invalid_state", `goal ${goal.id} is ${goal.status}`);
    const updated = await tx.goal.update({ where: { id: goal.id }, data: { status: input.status } });
    await tx.event.create({
      data: {
        tenantId,
        type: input.status === "active" ? "goal.activated" : "goal.cancelled",
        actorPersonId: actor.id,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: goal.studentPersonId,
        entityType: "goal",
        entityId: goal.id,
        payload: { from: goal.status, to: input.status },
      },
    });
    return updated;
  });
}

// ─── Progress ────────────────────────────────────────────────────────────────

export interface GoalProgressResult {
  goals: number;
  /** goal_progress rows written. */
  recorded: number;
  achieved: number;
  missed: number;
  /** Goals whose value did not move (nothing written). */
  unchanged: number;
}

/**
 * Recompute the progress of active goals — one student's (`studentPersonId`) or a whole
 * tenant's. Per goal at most one write and one event. `source` is stored on the sample
 * (event topic or "nightly").
 */
export function recomputeGoalProgress(db: PrismaClient | Db, input: { tenantId: string; studentPersonId?: string; source?: string; now?: Date }): Promise<GoalProgressResult> {
  return inTx(
    db,
    async (tx) => {
      const { tenantId } = input;
      const now = input.now ?? new Date();
      const today = dateOnly(now);
      const out: GoalProgressResult = { goals: 0, recorded: 0, achieved: 0, missed: 0, unchanged: 0 };
      if (input.studentPersonId !== undefined && !isUuid(input.studentPersonId)) return out;
      const goals = await tx.goal.findMany({
        where: { tenantId, status: "active", ...(input.studentPersonId ? { studentPersonId: input.studentPersonId } : {}) },
        orderBy: { id: "asc" },
      });
      out.goals = goals.length;
      for (const g of goals) {
        await tx.$queryRaw`SELECT id FROM goal WHERE tenant_id = ${tenantId}::uuid AND id = ${g.id}::uuid FOR UPDATE`;
        const metric = isGoalMetric(g.metric) ? g.metric : null;
        if (!metric) {
          out.unchanged += 1;
          continue;
        }
        const value = await measureGoalMetric(tx, { tenantId, studentPersonId: g.studentPersonId, metric, params: g.metricParams as GoalMetricParams, now });
        const met = value !== null && goalMet(metric, value, g.target);
        const pastDeadline = today > g.deadline;
        const status: GoalStatus = met ? "achieved" : pastDeadline ? "missed" : "active";
        const base = { tenantId, subjectPersonId: g.studentPersonId, entityType: "goal", entityId: g.id };

        if (value !== null) {
          const pct = goalProgressPct(metric, value, g.target, g.baseline);
          const last = await tx.goalProgress.findFirst({ where: { tenantId, goalId: g.id }, orderBy: [{ measuredAt: "desc" }, { id: "desc" }], select: { value: true, progressPct: true } });
          const moved = !last || !last.value.eq(value) || !last.progressPct.eq(pct);
          if (moved || status !== "active") {
            const sample = moved ? await tx.goalProgress.create({ data: { tenantId, goalId: g.id, measuredAt: now, value, progressPct: pct, source: input.source ?? null }, select: { id: true } }) : null;
            if (status !== "active") await tx.goal.update({ where: { id: g.id }, data: { status } });
            await tx.event.create({
              data: {
                ...base,
                type: sample ? "goal.progress_recorded" : `goal.${status}`,
                payload: { metric, value: value.toNumber(), progressPct: pct.toNumber(), target: g.target.toNumber(), status, statusChanged: status !== "active", source: input.source ?? null },
              },
            });
            if (sample) out.recorded += 1;
            if (status === "achieved") out.achieved += 1;
            if (status === "missed") out.missed += 1;
            continue;
          }
          out.unchanged += 1;
          continue;
        }
        if (status === "missed") {
          await tx.goal.update({ where: { id: g.id }, data: { status } });
          await tx.event.create({ data: { ...base, type: "goal.missed", payload: { metric, value: null, target: g.target.toNumber(), reason: "deadline_passed_without_data", source: input.source ?? null } } });
          out.missed += 1;
          continue;
        }
        out.unchanged += 1;
      }
      return out;
    },
    120_000,
  );
}

// ─── Weekly nudges ───────────────────────────────────────────────────────────

export interface WeeklyNudgeResult {
  goals: number;
  /** Nudges created now. */
  sent: number;
  /** Goals that already had their nudge this week. */
  alreadyNudged: number;
}

/**
 * Give every active goal (of one tenant, or of every tenant on the owner client) its nudge
 * for the current ISO week, in the tenant's time zone. `INSERT … ON CONFLICT DO NOTHING` on
 * (tenant, goal, week_start) makes it exactly one per goal per week however often it runs.
 * Each created nudge writes one event `nudge.sent` (in-app: delivered when created).
 */
export async function sendWeeklyGoalNudges(db: PrismaClient | Db, input: { tenantId?: string; now?: Date } = {}): Promise<WeeklyNudgeResult> {
  const now = input.now ?? new Date();
  const goals = await db.goal.findMany({
    where: { status: "active", ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
    select: { id: true, tenantId: true, studentPersonId: true, title: true, metric: true, target: true, deadline: true, tenant: { select: { timezone: true } } },
    orderBy: [{ tenantId: "asc" }, { id: "asc" }],
  });
  const out: WeeklyNudgeResult = { goals: goals.length, sent: 0, alreadyNudged: 0 };
  for (const g of goals) {
    const weekStart = isoWeekStart(localDate(now, g.tenant.timezone));
    const created = await inTx(db, async (tx) => {
      const last = await tx.goalProgress.findFirst({ where: { tenantId: g.tenantId, goalId: g.id }, orderBy: [{ measuredAt: "desc" }, { id: "desc" }], select: { progressPct: true, value: true } });
      const payload = {
        messageKey: "success.nudge.goalWeekly",
        params: { goalId: g.id, title: g.title, metric: g.metric, target: g.target.toNumber(), deadline: isoDate(g.deadline), progressPct: last?.progressPct.toNumber() ?? null, value: last?.value.toNumber() ?? null },
      };
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO nudge (tenant_id, goal_id, recipient_person_id, week_start, channel, status, payload, scheduled_for, sent_at, updated_at)
        VALUES (${g.tenantId}::uuid, ${g.id}::uuid, ${g.studentPersonId}::uuid, ${isoDate(weekStart)}::date, 'in_app'::nudge_channel, 'sent'::nudge_status,
                ${JSON.stringify(payload)}::jsonb, ${now}, ${now}, now())
        ON CONFLICT (tenant_id, goal_id, week_start) DO NOTHING
        RETURNING id::text`;
      const id = rows[0]?.id;
      if (!id) return false;
      await tx.event.create({
        data: { tenantId: g.tenantId, type: "nudge.sent", subjectPersonId: g.studentPersonId, entityType: "nudge", entityId: id, payload: { goalId: g.id, weekStart: isoDate(weekStart), channel: "in_app" } },
      });
      return true;
    });
    if (created) out.sent += 1;
    else out.alreadyNudged += 1;
  }
  return out;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Goals of a tenant (by student / status) with the latest progress sample. */
export function listGoals(db: PrismaClient | Db, tenantId: string, opts: { studentPersonId?: string; status?: GoalStatus[] } = {}) {
  return db.goal.findMany({
    where: { tenantId, ...(opts.studentPersonId && isUuid(opts.studentPersonId) ? { studentPersonId: opts.studentPersonId } : {}), ...(opts.status ? { status: { in: opts.status } } : {}) },
    include: { progress: { orderBy: [{ measuredAt: "desc" }, { id: "desc" }], take: 1 } },
    orderBy: [{ deadline: "asc" }, { id: "asc" }],
  });
}
