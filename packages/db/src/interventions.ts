/**
 * Interventions (success engine slice 3b). Service layer only.
 *
 * An intervention is a plan of support for one student: a type, a severity, an owner, a
 * status (planned → active → completed | cancelled), tasks, and an outcome. It is created
 * from a TEMPLATE (INTERVENTION_TEMPLATES — tasks with due offsets, the same for every
 * tenant and country; task titles in sq/en/ar, picked by the tenant's default locale) or
 * ad hoc with its own tasks.
 *
 * Outcome capture:
 *   risk_before  the student's latest risk score when the intervention is OPENED (created);
 *   risk_after   the student's latest risk score when it is CLOSED (completed or cancelled);
 *   outcome      given by the closer, or derived from the change in risk:
 *                after <= before − OUTCOME_RULES.minChange → improved,
 *                after >= before + minChange → worsened, otherwise no_change;
 *                inconclusive when either score is missing.
 *
 * Every mutation writes exactly one `event` row in the same transaction:
 * intervention.created | .started | .completed | .cancelled,
 * intervention_task.created | intervention_task.updated.
 * Works on the owner client or the app role inside `withTenant`.
 */
import { Prisma, type InterventionOutcome, type InterventionSeverity, type InterventionStatus, type InterventionTaskStatus, type PrismaClient } from "@prisma/client";

import { type Db, DAY_MS, dateOnly, findPerson, hasActiveRole, inTx, isoDate, isUuid, latestRisk, parseIsoDate, STAFF_ROLES } from "./success-common";

const Decimal = Prisma.Decimal;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type InterventionErrorCode =
  | "unknown_intervention"
  | "unknown_task"
  | "unknown_template"
  | "unknown_student"
  | "unknown_person"
  | "unknown_alert"
  | "not_authorized"
  | "invalid_state"
  | "invalid_input";

export class InterventionError extends Error {
  readonly code: InterventionErrorCode;
  constructor(code: InterventionErrorCode, message: string) {
    super(message);
    this.name = "InterventionError";
    this.code = code;
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

export type Locale = "sq" | "en" | "ar";
type Localised = Record<Locale, string>;

export interface InterventionTemplateTask {
  key: string;
  title: Localised;
  /** Due date = start + offsetDays. */
  offsetDays: number;
}

export interface InterventionTemplate {
  key: string;
  type: string;
  name: Localised;
  severity: InterventionSeverity;
  durationDays: number;
  tasks: readonly InterventionTemplateTask[];
}

/** Product templates — identical for every tenant and country. */
export const INTERVENTION_TEMPLATES: Readonly<Record<string, InterventionTemplate>> = {
  academic_tutoring: {
    key: "academic_tutoring",
    type: "academic_tutoring",
    name: { en: "Academic tutoring", sq: "Mësim plotësues", ar: "دروس تقوية أكاديمية" },
    severity: "medium",
    durationDays: 42,
    tasks: [
      { key: "diagnose_gaps", offsetDays: 3, title: { en: "Identify the learning gaps with the subject teacher", sq: "Identifiko boshllëqet në të nxënë me mësuesin e lëndës", ar: "تحديد الفجوات التعليمية مع معلم المادة" } },
      { key: "schedule_sessions", offsetDays: 7, title: { en: "Schedule weekly tutoring sessions", sq: "Planifiko seancat javore të mësimit plotësues", ar: "جدولة جلسات تقوية أسبوعية" } },
      { key: "midpoint_check", offsetDays: 21, title: { en: "Mid-point check of grades", sq: "Kontroll i notave në mes të periudhës", ar: "مراجعة الدرجات في منتصف المدة" } },
      { key: "final_review", offsetDays: 42, title: { en: "Final review and outcome", sq: "Rishikimi përfundimtar dhe rezultati", ar: "المراجعة النهائية والنتيجة" } },
    ],
  },
  attendance_plan: {
    key: "attendance_plan",
    type: "attendance_plan",
    name: { en: "Attendance plan", sq: "Plan për frekuentimin", ar: "خطة الحضور" },
    severity: "medium",
    durationDays: 28,
    tasks: [
      { key: "contact_family", offsetDays: 2, title: { en: "Contact the family about absences", sq: "Kontakto familjen për mungesat", ar: "التواصل مع الأسرة بشأن الغياب" } },
      { key: "agree_plan", offsetDays: 7, title: { en: "Agree an attendance plan with the student", sq: "Bie dakord për një plan frekuentimi me nxënësin", ar: "الاتفاق على خطة حضور مع الطالب" } },
      { key: "weekly_review", offsetDays: 14, title: { en: "Review attendance weekly", sq: "Rishiko frekuentimin çdo javë", ar: "مراجعة الحضور أسبوعياً" } },
      { key: "final_review", offsetDays: 28, title: { en: "Final review and outcome", sq: "Rishikimi përfundimtar dhe rezultati", ar: "المراجعة النهائية والنتيجة" } },
    ],
  },
  mentoring: {
    key: "mentoring",
    type: "mentoring",
    name: { en: "Mentoring", sq: "Mentorim", ar: "إرشاد" },
    severity: "low",
    durationDays: 56,
    tasks: [
      { key: "assign_mentor", offsetDays: 3, title: { en: "Assign a mentor", sq: "Cakto një mentor", ar: "تعيين مرشد" } },
      { key: "first_meeting", offsetDays: 7, title: { en: "First mentoring meeting", sq: "Takimi i parë i mentorimit", ar: "أول لقاء إرشادي" } },
      { key: "final_review", offsetDays: 56, title: { en: "Final review and outcome", sq: "Rishikimi përfundimtar dhe rezultati", ar: "المراجعة النهائية والنتيجة" } },
    ],
  },
  family_meeting: {
    key: "family_meeting",
    type: "family_meeting",
    name: { en: "Family meeting", sq: "Takim me familjen", ar: "اجتماع مع الأسرة" },
    severity: "high",
    durationDays: 14,
    tasks: [
      { key: "invite_family", offsetDays: 2, title: { en: "Invite the family to a meeting", sq: "Fto familjen në një takim", ar: "دعوة الأسرة إلى اجتماع" } },
      { key: "hold_meeting", offsetDays: 7, title: { en: "Hold the meeting and record agreed actions", sq: "Zhvillo takimin dhe regjistro veprimet e rëna dakord", ar: "عقد الاجتماع وتسجيل الإجراءات المتفق عليها" } },
      { key: "follow_up", offsetDays: 14, title: { en: "Follow up on the agreed actions", sq: "Ndiq veprimet e rëna dakord", ar: "متابعة الإجراءات المتفق عليها" } },
    ],
  },
};

export const OUTCOME_RULES = {
  /** Risk points the score must move (down / up) to count as improved / worsened. */
  minChange: 5,
} as const;

/** Pure: outcome from risk before/after (exact decimals). */
export function deriveOutcome(riskBefore: Prisma.Decimal | number | null, riskAfter: Prisma.Decimal | number | null): InterventionOutcome {
  if (riskBefore === null || riskAfter === null) return "inconclusive";
  const delta = new Decimal(riskAfter).minus(riskBefore);
  if (delta.lte(-OUTCOME_RULES.minChange)) return "improved";
  if (delta.gte(OUTCOME_RULES.minChange)) return "worsened";
  return "no_change";
}

const SEVERITIES: readonly InterventionSeverity[] = ["low", "medium", "high"];
const OUTCOMES: readonly InterventionOutcome[] = ["improved", "no_change", "worsened", "inconclusive"];
const TASK_STATUSES: readonly InterventionTaskStatus[] = ["todo", "in_progress", "done", "skipped"];
const OPEN_STATUSES: readonly InterventionStatus[] = ["planned", "active"];

const pickLocale = (l: string | null | undefined): Locale => (l === "sq" || l === "ar" ? l : "en");

async function requireStaff(tx: Db, tenantId: string, personId: unknown, now: Date, what: string): Promise<string> {
  const p = await findPerson(tx, tenantId, personId);
  if (!p) throw new InterventionError("unknown_person", `person ${String(personId)} not found in tenant`);
  if (!(await hasActiveRole(tx, tenantId, p.id, STAFF_ROLES, now))) throw new InterventionError("not_authorized", `${what} needs role ${STAFF_ROLES.join(", ")}`);
  return p.id;
}

async function lockIntervention(tx: Db, tenantId: string, interventionId: string) {
  if (!isUuid(interventionId)) throw new InterventionError("unknown_intervention", `intervention ${interventionId} not found in tenant`);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM intervention WHERE tenant_id = ${tenantId}::uuid AND id = ${interventionId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new InterventionError("unknown_intervention", `intervention ${interventionId} not found in tenant`);
  return tx.intervention.findFirstOrThrow({ where: { tenantId, id: interventionId } });
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface NewInterventionTask {
  title: string;
  dueOn?: string | null;
  assigneePersonId?: string | null;
}

export interface CreateInterventionInput {
  tenantId: string;
  studentPersonId: string;
  /** A key of INTERVENTION_TEMPLATES; or give `type` (and `tasks`) for an ad-hoc plan. */
  templateKey?: string;
  type?: string;
  severity?: InterventionSeverity;
  /** Staff member responsible (default: the actor). Template tasks are assigned to them. */
  ownerPersonId?: string;
  /** Staff member creating it (teacher, advisor or admin). */
  actorPersonId: string;
  actorUserId?: string | null;
  alertId?: string | null;
  actionCardId?: string | null;
  /** Start right away (status active, started_on = startOn or today). Default: planned. */
  start?: boolean;
  /** YYYY-MM-DD: the date task due dates count from (default today). */
  startOn?: string;
  /** Extra (ad hoc) or replacement tasks; with a template they are appended. */
  tasks?: NewInterventionTask[];
  now?: Date;
}

/**
 * Open an intervention: captures risk_before (the student's latest risk score, null when
 * never scored), creates the template's tasks, one event `intervention.created`.
 */
export function createIntervention(db: PrismaClient | Db, input: CreateInterventionInput) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const actor = await requireStaff(tx, tenantId, input.actorPersonId, now, "creating an intervention");
    const owner = input.ownerPersonId ? await requireStaff(tx, tenantId, input.ownerPersonId, now, "owning an intervention") : actor;
    const student = await findPerson(tx, tenantId, input.studentPersonId);
    if (!student) throw new InterventionError("unknown_student", `student ${input.studentPersonId} not found in tenant`);

    const template = input.templateKey !== undefined ? INTERVENTION_TEMPLATES[input.templateKey] : undefined;
    if (input.templateKey !== undefined && !template) throw new InterventionError("unknown_template", `unknown intervention template "${input.templateKey}"`);
    const type = (input.type ?? template?.type)?.trim();
    if (!type) throw new InterventionError("invalid_input", "type or templateKey is required");
    const severity = input.severity ?? template?.severity ?? "medium";
    if (!SEVERITIES.includes(severity)) throw new InterventionError("invalid_input", `severity must be one of ${SEVERITIES.join(", ")}`);

    if (input.alertId) {
      const alert = isUuid(input.alertId) ? await tx.alert.findFirst({ where: { tenantId, id: input.alertId }, select: { studentPersonId: true } }) : null;
      if (!alert || alert.studentPersonId !== student.id) throw new InterventionError("unknown_alert", `alert ${input.alertId} not found for this student`);
    }
    if (input.actionCardId) {
      const card = isUuid(input.actionCardId) ? await tx.actionCard.findFirst({ where: { tenantId, id: input.actionCardId }, select: { subjectPersonId: true } }) : null;
      if (!card || card.subjectPersonId !== student.id) throw new InterventionError("invalid_input", `action card ${input.actionCardId} not found for this student`);
    }

    const startDate = input.startOn !== undefined ? parseIsoDate(input.startOn) : dateOnly(now);
    if (!startDate) throw new InterventionError("invalid_input", "startOn must be a YYYY-MM-DD date");

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultLocale: true } });
    const locale = pickLocale(tenant.defaultLocale);
    const tasks: { title: string; dueOn: Date | null; assigneePersonId: string | null }[] = (template?.tasks ?? []).map((t) => ({
      title: t.title[locale],
      dueOn: new Date(startDate.getTime() + t.offsetDays * DAY_MS),
      assigneePersonId: owner,
    }));
    for (const t of input.tasks ?? []) {
      const title = t.title?.trim();
      if (!title) throw new InterventionError("invalid_input", "every task needs a title");
      const dueOn = t.dueOn ? parseIsoDate(t.dueOn) : null;
      if (t.dueOn && !dueOn) throw new InterventionError("invalid_input", "task dueOn must be a YYYY-MM-DD date");
      let assignee: string | null = owner;
      if (t.assigneePersonId) {
        const p = await findPerson(tx, tenantId, t.assigneePersonId);
        if (!p) throw new InterventionError("unknown_person", `person ${t.assigneePersonId} not found in tenant`);
        assignee = p.id;
      }
      tasks.push({ title, dueOn, assigneePersonId: assignee });
    }

    const risk = await latestRisk(tx, tenantId, student.id);
    const status: InterventionStatus = input.start ? "active" : "planned";
    const created = await tx.intervention.create({
      data: {
        tenantId,
        studentPersonId: student.id,
        templateKey: template?.key ?? null,
        type,
        severity,
        ownerPersonId: owner,
        status,
        actionCardId: input.actionCardId ?? null,
        alertId: input.alertId ?? null,
        startedOn: input.start ? startDate : null,
        riskBefore: risk?.score ?? null,
      },
    });
    if (tasks.length > 0) {
      await tx.interventionTask.createMany({ data: tasks.map((t, i) => ({ tenantId, interventionId: created.id, sequence: i + 1, ...t })) });
    }
    await tx.event.create({
      data: {
        tenantId,
        type: "intervention.created",
        actorPersonId: actor,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: student.id,
        entityType: "intervention",
        entityId: created.id,
        payload: { templateKey: template?.key ?? null, type, severity, status, ownerPersonId: owner, tasks: tasks.length, riskBefore: risk ? risk.score.toNumber() : null },
        evidenceRefs: [
          ...(risk ? [{ type: "risk_score", id: risk.id }] : []),
          ...(input.alertId ? [{ type: "alert", id: input.alertId }] : []),
          ...(input.actionCardId ? [{ type: "action_card", id: input.actionCardId }] : []),
        ],
      },
    });
    return { intervention: created, tasks: tasks.length, riskScoreId: risk?.id ?? null };
  });
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface InterventionActionInput {
  tenantId: string;
  interventionId: string;
  actorPersonId: string;
  actorUserId?: string | null;
  now?: Date;
}

/** planned → active (started_on = startOn or today). One event `intervention.started`. */
export function startIntervention(db: PrismaClient | Db, input: InterventionActionInput & { startOn?: string }) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const actor = await requireStaff(tx, tenantId, input.actorPersonId, now, "starting an intervention");
    const iv = await lockIntervention(tx, tenantId, input.interventionId);
    if (iv.status !== "planned") throw new InterventionError("invalid_state", `intervention ${iv.id} is ${iv.status}`);
    const startedOn = input.startOn !== undefined ? parseIsoDate(input.startOn) : dateOnly(now);
    if (!startedOn) throw new InterventionError("invalid_input", "startOn must be a YYYY-MM-DD date");
    const updated = await tx.intervention.update({ where: { id: iv.id }, data: { status: "active", startedOn } });
    await tx.event.create({
      data: {
        tenantId,
        type: "intervention.started",
        actorPersonId: actor,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: iv.studentPersonId,
        entityType: "intervention",
        entityId: iv.id,
        payload: { startedOn: isoDate(startedOn) },
      },
    });
    return updated;
  });
}

export interface CloseInterventionInput extends InterventionActionInput {
  /** completed (default) or cancelled. */
  status?: "completed" | "cancelled";
  /** Default: derived from risk before/after (completed) or null (cancelled). */
  outcome?: InterventionOutcome;
  outcomeNote?: string | null;
  /** YYYY-MM-DD, default today. */
  endedOn?: string;
}

/**
 * Close an intervention (planned|active → completed|cancelled): captures risk_after (the
 * student's latest risk score now) and the outcome. One event `intervention.completed` /
 * `intervention.cancelled` carrying risk before, after and the change.
 */
export function closeIntervention(db: PrismaClient | Db, input: CloseInterventionInput) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const to = input.status ?? "completed";
    if (to !== "completed" && to !== "cancelled") throw new InterventionError("invalid_input", "status must be completed or cancelled");
    if (input.outcome !== undefined && !OUTCOMES.includes(input.outcome)) throw new InterventionError("invalid_input", `outcome must be one of ${OUTCOMES.join(", ")}`);
    const actor = await requireStaff(tx, tenantId, input.actorPersonId, now, "closing an intervention");
    const iv = await lockIntervention(tx, tenantId, input.interventionId);
    if (!OPEN_STATUSES.includes(iv.status)) throw new InterventionError("invalid_state", `intervention ${iv.id} is already ${iv.status}`);
    const endedOn = input.endedOn !== undefined ? parseIsoDate(input.endedOn) : dateOnly(now);
    if (!endedOn) throw new InterventionError("invalid_input", "endedOn must be a YYYY-MM-DD date");
    if (iv.startedOn && endedOn < iv.startedOn) throw new InterventionError("invalid_input", "endedOn must be on or after startedOn");

    const risk = await latestRisk(tx, tenantId, iv.studentPersonId);
    const riskAfter = risk?.score ?? null;
    const derived = deriveOutcome(iv.riskBefore, riskAfter);
    const outcome = input.outcome ?? (to === "completed" ? derived : null);
    const updated = await tx.intervention.update({
      where: { id: iv.id },
      data: { status: to, endedOn, riskAfter, outcome, outcomeNote: input.outcomeNote?.trim() || null },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: `intervention.${to}`,
        actorPersonId: actor,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: iv.studentPersonId,
        entityType: "intervention",
        entityId: iv.id,
        payload: {
          riskBefore: iv.riskBefore?.toNumber() ?? null,
          riskAfter: riskAfter?.toNumber() ?? null,
          riskChange: iv.riskBefore && riskAfter ? riskAfter.minus(iv.riskBefore).toNumber() : null,
          outcome,
          derivedOutcome: derived,
          endedOn: isoDate(endedOn),
        },
        evidenceRefs: risk ? [{ type: "risk_score", id: risk.id }] : [],
      },
    });
    return updated;
  });
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** Add a task to an open intervention. One event `intervention_task.created`. */
export function addInterventionTask(db: PrismaClient | Db, input: InterventionActionInput & NewInterventionTask) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const actor = await requireStaff(tx, tenantId, input.actorPersonId, now, "adding a task");
    const iv = await lockIntervention(tx, tenantId, input.interventionId);
    if (!OPEN_STATUSES.includes(iv.status)) throw new InterventionError("invalid_state", `intervention ${iv.id} is ${iv.status}`);
    const title = input.title?.trim();
    if (!title) throw new InterventionError("invalid_input", "title is required");
    const dueOn = input.dueOn ? parseIsoDate(input.dueOn) : null;
    if (input.dueOn && !dueOn) throw new InterventionError("invalid_input", "dueOn must be a YYYY-MM-DD date");
    let assignee: string | null = iv.ownerPersonId;
    if (input.assigneePersonId) {
      const p = await findPerson(tx, tenantId, input.assigneePersonId);
      if (!p) throw new InterventionError("unknown_person", `person ${input.assigneePersonId} not found in tenant`);
      assignee = p.id;
    }
    const max = await tx.interventionTask.aggregate({ where: { tenantId, interventionId: iv.id }, _max: { sequence: true } });
    const task = await tx.interventionTask.create({
      data: { tenantId, interventionId: iv.id, sequence: (max._max.sequence ?? 0) + 1, title, dueOn, assigneePersonId: assignee },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: "intervention_task.created",
        actorPersonId: actor,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: iv.studentPersonId,
        entityType: "intervention_task",
        entityId: task.id,
        payload: { interventionId: iv.id, title, dueOn: dueOn ? isoDate(dueOn) : null, assigneePersonId: assignee },
      },
    });
    return task;
  });
}

/** Change a task's status (done stamps completed_at). One event `intervention_task.updated`. */
export function setInterventionTaskStatus(db: PrismaClient | Db, input: { tenantId: string; taskId: string; status: InterventionTaskStatus; actorPersonId: string; actorUserId?: string | null; now?: Date }) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    if (!TASK_STATUSES.includes(input.status)) throw new InterventionError("invalid_input", `status must be one of ${TASK_STATUSES.join(", ")}`);
    const actor = await findPerson(tx, tenantId, input.actorPersonId);
    if (!actor) throw new InterventionError("unknown_person", `person ${input.actorPersonId} not found in tenant`);
    const task = isUuid(input.taskId) ? await tx.interventionTask.findFirst({ where: { tenantId, id: input.taskId } }) : null;
    if (!task) throw new InterventionError("unknown_task", `task ${input.taskId} not found in tenant`);
    // The task's assignee may update it; otherwise staff.
    if (task.assigneePersonId !== actor.id && !(await hasActiveRole(tx, tenantId, actor.id, STAFF_ROLES, now)))
      throw new InterventionError("not_authorized", "only the assignee or staff may update a task");
    const iv = await lockIntervention(tx, tenantId, task.interventionId);
    if (!OPEN_STATUSES.includes(iv.status)) throw new InterventionError("invalid_state", `intervention ${iv.id} is ${iv.status}`);
    if (task.status === input.status) throw new InterventionError("invalid_state", `task is already ${task.status}`);
    const updated = await tx.interventionTask.update({ where: { id: task.id }, data: { status: input.status, completedAt: input.status === "done" ? now : null } });
    await tx.event.create({
      data: {
        tenantId,
        type: "intervention_task.updated",
        actorPersonId: actor.id,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: iv.studentPersonId,
        entityType: "intervention_task",
        entityId: task.id,
        payload: { interventionId: iv.id, from: task.status, to: input.status },
      },
    });
    return updated;
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Interventions of a tenant with their tasks (filter by student / status / owner). */
export function listInterventions(db: PrismaClient | Db, tenantId: string, opts: { studentPersonId?: string; status?: InterventionStatus[]; ownerPersonId?: string } = {}) {
  return db.intervention.findMany({
    where: {
      tenantId,
      ...(opts.studentPersonId && isUuid(opts.studentPersonId) ? { studentPersonId: opts.studentPersonId } : {}),
      ...(opts.status ? { status: { in: opts.status } } : {}),
      ...(opts.ownerPersonId && isUuid(opts.ownerPersonId) ? { ownerPersonId: opts.ownerPersonId } : {}),
    },
    include: { tasks: { orderBy: { sequence: "asc" } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}
