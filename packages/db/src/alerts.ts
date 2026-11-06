/**
 * Alerts (success engine slice 3b). Service layer only.
 *
 * Each tenant's `alert_rule` rows hold a threshold ({ op, value }) on a metric and an
 * escalation ladder ([{ level, role, slaMinutes }], e.g. teacher → advisor → parent).
 *
 *   evaluateRiskAlerts   runs inside every risk recompute (student, tenant, weights change)
 *                        against the NEW risk score: for each active `risk_score` rule a
 *                        crossed threshold OPENS an alert (one unresolved alert per rule ×
 *                        student — re-crossing leaves it alone), and a score back on the safe
 *                        side RESOLVES the unresolved one (reason threshold_cleared).
 *   acknowledgeAlert     the role on the hook (or a staff role already passed on the
 *                        ladder, or an admin; a guardian of the student once the ladder
 *                        reached `parent`) records an acknowledgement: the SLA timer stops.
 *   escalateDueAlerts    the scheduled job (@ssos/jobs, every minute): an open/escalated
 *                        alert whose SLA (`due_at`) has ELAPSED moves one rung up the ladder
 *                        (new role, new due_at = now + that rung's slaMinutes). On the last
 *                        rung an elapsed SLA is recorded once (alert.sla_expired) and the
 *                        timer stops. Nothing moves before due_at.
 *   resolveAlert / dismissAlert   staff close an alert.
 *
 * Every mutation writes exactly one `event` row in the same transaction:
 * alert.opened | .acknowledged | .escalated | .sla_expired | .resolved | .dismissed.
 * Rules are data (seeded per tenant from success-defaults.ts); nothing branches on country.
 * Works on the owner client or the app role inside `withTenant` (every query filters by tenant).
 */
import { Prisma, type AlertSeverity, type AlertState, type PrismaClient } from "@prisma/client";

import type { RiskScoreView } from "./risk-model";
import { type Db, findPerson, hasActiveRole, inTx, isUuid, MINUTE_MS, STAFF_ROLES } from "./success-common";
import type { EscalationRole, EscalationStep } from "./success-defaults";

const Decimal = Prisma.Decimal;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AlertErrorCode = "unknown_alert" | "unknown_person" | "not_authorized" | "invalid_state" | "invalid_input";

/** Thrown for an alert operation that cannot be applied. Nothing is written. */
export class AlertError extends Error {
  readonly code: AlertErrorCode;
  constructor(code: AlertErrorCode, message: string) {
    super(message);
    this.name = "AlertError";
    this.code = code;
  }
}

// ─── Rule parsing (pure) ─────────────────────────────────────────────────────

export type ThresholdOp = "gte" | "gt" | "lte" | "lt";
export interface AlertThreshold {
  op: ThresholdOp;
  value: number;
  windowDays?: number;
}

const OPS: readonly ThresholdOp[] = ["gte", "gt", "lte", "lt"];
const ROLES: readonly EscalationRole[] = ["teacher", "advisor", "parent"];
export const UNRESOLVED_ALERT_STATES: readonly AlertState[] = ["open", "acknowledged", "escalated"];

/** Validate a rule threshold; null when unusable (the rule is then skipped, never guessed). */
export function parseThreshold(raw: unknown): AlertThreshold | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!OPS.includes(o.op as ThresholdOp) || typeof o.value !== "number" || !Number.isFinite(o.value)) return null;
  return { op: o.op as ThresholdOp, value: o.value, ...(typeof o.windowDays === "number" ? { windowDays: o.windowDays } : {}) };
}

/** Validate an escalation ladder; returns the rungs ordered by level, or null when unusable. */
export function parseLadder(raw: unknown): EscalationStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: EscalationStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") return null;
    const o = s as Record<string, unknown>;
    if (typeof o.level !== "number" || !Number.isInteger(o.level) || o.level < 0) return null;
    if (!ROLES.includes(o.role as EscalationRole)) return null;
    if (typeof o.slaMinutes !== "number" || !Number.isInteger(o.slaMinutes) || o.slaMinutes <= 0) return null;
    steps.push({ level: o.level, role: o.role as EscalationRole, slaMinutes: o.slaMinutes });
  }
  steps.sort((a, b) => a.level - b.level);
  return steps;
}

/** Exact decimal comparison of a metric value against a threshold. */
export function crosses(value: number | Prisma.Decimal, t: AlertThreshold): boolean {
  const v = new Decimal(value);
  switch (t.op) {
    case "gte":
      return v.gte(t.value);
    case "gt":
      return v.gt(t.value);
    case "lte":
      return v.lte(t.value);
    case "lt":
      return v.lt(t.value);
  }
}

/** Rung index of an alert's level on a ladder (clamped to the last rung). */
const rungIndex = (ladder: EscalationStep[], level: number) => Math.min(Math.max(0, ladder.findIndex((s) => s.level >= level)), ladder.length - 1);

// ─── Evaluate (inside the recompute) ─────────────────────────────────────────

export interface AlertEvaluation {
  opened: string[];
  resolved: string[];
  /** Rules whose threshold is crossed and that already have an unresolved alert. */
  stillOpen: number;
  /** Active risk_score rules skipped because their threshold or ladder is malformed. */
  invalidRules: string[];
}

export const emptyAlertEvaluation = (): AlertEvaluation => ({ opened: [], resolved: [], stillOpen: 0, invalidRules: [] });

/**
 * Evaluate the tenant's active `risk_score` rules against one fresh risk score. Called by
 * the risk model inside its transaction (owner role); also usable on its own.
 */
export async function evaluateRiskAlerts(tx: Db, input: { tenantId: string; riskScore: Pick<RiskScoreView, "id" | "studentPersonId" | "score" | "band" | "modelVersion">; now?: Date }): Promise<AlertEvaluation> {
  const { tenantId, riskScore } = input;
  const now = input.now ?? new Date();
  const out = emptyAlertEvaluation();
  const rules = await tx.alertRule.findMany({ where: { tenantId, isActive: true, metric: "risk_score" }, orderBy: { key: "asc" } });
  if (rules.length === 0) return out;
  const unresolved = await tx.alert.findMany({
    where: { tenantId, studentPersonId: riskScore.studentPersonId, ruleId: { in: rules.map((r) => r.id) }, state: { in: [...UNRESOLVED_ALERT_STATES] } },
    select: { id: true, ruleId: true },
  });
  const openByRule = new Map(unresolved.map((a) => [a.ruleId, a.id]));
  const evidenceRefs = [{ type: "risk_score", id: riskScore.id }];

  for (const rule of rules) {
    const threshold = parseThreshold(rule.threshold);
    const ladder = parseLadder(rule.escalation);
    if (!threshold || !ladder) {
      out.invalidRules.push(rule.key);
      continue;
    }
    const hit = crosses(riskScore.score, threshold);
    const openId = openByRule.get(rule.id);
    if (hit && openId) {
      out.stillOpen += 1;
    } else if (hit) {
      const first = ladder[0]!;
      const trigger = { metric: rule.metric, value: riskScore.score, op: threshold.op, threshold: threshold.value, band: riskScore.band, modelVersion: riskScore.modelVersion, riskScoreId: riskScore.id, evidenceRefs };
      const alert = await tx.alert.create({
        data: {
          tenantId,
          ruleId: rule.id,
          studentPersonId: riskScore.studentPersonId,
          state: "open",
          severity: rule.severity,
          escalationLevel: first.level,
          assigneeRole: first.role,
          dueAt: new Date(now.getTime() + first.slaMinutes * MINUTE_MS),
          trigger,
          triggeredAt: now,
        },
        select: { id: true },
      });
      await tx.event.create({
        data: {
          tenantId,
          type: "alert.opened",
          subjectPersonId: riskScore.studentPersonId,
          entityType: "alert",
          entityId: alert.id,
          payload: { ruleKey: rule.key, severity: rule.severity, assigneeRole: first.role, slaMinutes: first.slaMinutes, value: riskScore.score, threshold: threshold.value, op: threshold.op },
          evidenceRefs,
        },
      });
      out.opened.push(alert.id);
    } else if (openId) {
      await tx.alert.update({ where: { id: openId }, data: { state: "resolved", resolvedAt: now, dueAt: null } });
      await tx.event.create({
        data: {
          tenantId,
          type: "alert.resolved",
          subjectPersonId: riskScore.studentPersonId,
          entityType: "alert",
          entityId: openId,
          payload: { ruleKey: rule.key, reason: "threshold_cleared", value: riskScore.score, threshold: threshold.value, op: threshold.op },
          evidenceRefs,
        },
      });
      out.resolved.push(openId);
    }
  }
  return out;
}

// ─── Acknowledge / resolve / dismiss ─────────────────────────────────────────

export interface AlertAcknowledgement {
  personId: string;
  role: string;
  at: string;
  level: number;
  note?: string;
}

async function loadAlertForUpdate(tx: Db, tenantId: string, alertId: string) {
  if (!isUuid(alertId)) throw new AlertError("unknown_alert", `alert ${alertId} not found in tenant`);
  // Row lock: acknowledgement and escalation of the same alert are serialised.
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM alert WHERE tenant_id = ${tenantId}::uuid AND id = ${alertId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new AlertError("unknown_alert", `alert ${alertId} not found in tenant`);
  return tx.alert.findFirstOrThrow({ where: { tenantId, id: alertId }, include: { rule: { select: { key: true, escalation: true } } } });
}

/**
 * The role the person acts in for this alert, or null when they may not act on it.
 * Staff: the rung's role, any staff role at or below the current rung, advisor and admin
 * always. Parent: a guardian of the student, once the ladder reached a parent rung.
 */
async function actingRole(tx: Db, tenantId: string, alert: { studentPersonId: string; escalationLevel: number; rule: { escalation: Prisma.JsonValue } }, personId: string, now: Date): Promise<string | null> {
  const ladder = parseLadder(alert.rule.escalation) ?? [];
  const reached = ladder.filter((s) => s.level <= alert.escalationLevel).map((s) => s.role);
  const staff = [...new Set([...reached.filter((r) => r !== "parent"), "advisor", "admin"])];
  for (const role of staff) if (await hasActiveRole(tx, tenantId, personId, [role], now)) return role;
  if (reached.includes("parent")) {
    const g = await tx.guardianship.findFirst({ where: { tenantId, guardianPersonId: personId, studentPersonId: alert.studentPersonId }, select: { id: true } });
    if (g) return "parent";
  }
  return null;
}

export interface AlertActionInput {
  tenantId: string;
  alertId: string;
  personId: string;
  actorUserId?: string | null;
  note?: string | null;
  now?: Date;
}

/**
 * Record an acknowledgement: state → acknowledged, the SLA timer stops (due_at cleared),
 * the acknowledgement is appended. One event. Throws `unknown_alert`, `unknown_person`,
 * `not_authorized`, `invalid_state` (already acknowledged, resolved or dismissed).
 */
export function acknowledgeAlert(db: PrismaClient | Db, input: AlertActionInput) {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const alert = await loadAlertForUpdate(tx, tenantId, input.alertId);
    if (alert.state !== "open" && alert.state !== "escalated") throw new AlertError("invalid_state", `alert ${alert.id} is ${alert.state}`);
    if (!(await findPerson(tx, tenantId, input.personId))) throw new AlertError("unknown_person", `person ${input.personId} not found in tenant`);
    const role = await actingRole(tx, tenantId, alert, input.personId, now);
    if (!role) throw new AlertError("not_authorized", "acknowledging this alert needs a role on its escalation ladder (or a guardian once it reached parent)");
    const note = input.note?.trim() || undefined;
    const ack: AlertAcknowledgement = { personId: input.personId, role, at: now.toISOString(), level: alert.escalationLevel, ...(note ? { note } : {}) };
    const acks = [...((alert.acknowledgements as unknown as AlertAcknowledgement[] | null) ?? []), ack];
    const updated = await tx.alert.update({
      where: { id: alert.id },
      data: { state: "acknowledged", dueAt: null, acknowledgements: acks as unknown as Prisma.InputJsonValue },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: "alert.acknowledged",
        actorPersonId: input.personId,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: alert.studentPersonId,
        entityType: "alert",
        entityId: alert.id,
        payload: { ruleKey: alert.rule.key, role, level: alert.escalationLevel, overdue: alert.dueAt !== null && alert.dueAt <= now, note: note ?? null },
      },
    });
    return updated;
  });
}

async function closeAlert(db: PrismaClient | Db, input: AlertActionInput, to: "resolved" | "dismissed") {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const now = input.now ?? new Date();
    const alert = await loadAlertForUpdate(tx, tenantId, input.alertId);
    if (!UNRESOLVED_ALERT_STATES.includes(alert.state)) throw new AlertError("invalid_state", `alert ${alert.id} is already ${alert.state}`);
    if (!(await findPerson(tx, tenantId, input.personId))) throw new AlertError("unknown_person", `person ${input.personId} not found in tenant`);
    if (!(await hasActiveRole(tx, tenantId, input.personId, STAFF_ROLES, now))) throw new AlertError("not_authorized", `closing an alert needs role ${STAFF_ROLES.join(", ")}`);
    const note = input.note?.trim() || null;
    const updated = await tx.alert.update({ where: { id: alert.id }, data: { state: to, dueAt: null, resolvedAt: now } });
    await tx.event.create({
      data: {
        tenantId,
        type: `alert.${to}`,
        actorPersonId: input.personId,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: alert.studentPersonId,
        entityType: "alert",
        entityId: alert.id,
        payload: { ruleKey: alert.rule.key, reason: "manual", fromState: alert.state, note },
      },
    });
    return updated;
  });
}

/** Staff resolve an unresolved alert. One event. */
export const resolveAlert = (db: PrismaClient | Db, input: AlertActionInput) => closeAlert(db, input, "resolved");
/** Staff dismiss an unresolved alert (false positive). One event. */
export const dismissAlert = (db: PrismaClient | Db, input: AlertActionInput) => closeAlert(db, input, "dismissed");

// ─── Escalation (scheduled job) ──────────────────────────────────────────────

export interface EscalationStepResult {
  alertId: string;
  tenantId: string;
  action: "escalated" | "sla_expired";
  fromLevel: number;
  toLevel: number;
  fromRole: string;
  toRole: string;
  dueAt: string | null;
}

export interface EscalateDueAlertsResult {
  due: number;
  escalated: number;
  slaExpired: number;
  steps: EscalationStepResult[];
}

/**
 * Advance every alert whose SLA has elapsed (`due_at <= now`, state open|escalated) by ONE
 * rung. Each alert is its own transaction with a row lock re-checking the state, so a
 * concurrent acknowledgement wins cleanly and a re-run never double-escalates. Owner client
 * across tenants (the job), or scope to one `tenantId` (app role inside withTenant too).
 */
export async function escalateDueAlerts(db: PrismaClient | Db, input: { now?: Date; tenantId?: string; limit?: number } = {}): Promise<EscalateDueAlertsResult> {
  const now = input.now ?? new Date();
  const due = await db.alert.findMany({
    where: { ...(input.tenantId ? { tenantId: input.tenantId } : {}), state: { in: ["open", "escalated"] }, dueAt: { lte: now } },
    select: { id: true, tenantId: true },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: input.limit ?? 1000,
  });
  const out: EscalateDueAlertsResult = { due: due.length, escalated: 0, slaExpired: 0, steps: [] };
  for (const a of due) {
    const step = await inTx(db, (tx) => escalateOne(tx, a.tenantId, a.id, now));
    if (!step) continue;
    out.steps.push(step);
    if (step.action === "escalated") out.escalated += 1;
    else out.slaExpired += 1;
  }
  return out;
}

async function escalateOne(tx: Db, tenantId: string, alertId: string, now: Date): Promise<EscalationStepResult | null> {
  const alert = await loadAlertForUpdate(tx, tenantId, alertId);
  // Re-check under the lock: acknowledged/closed meanwhile, or not due yet -> nothing to do.
  if ((alert.state !== "open" && alert.state !== "escalated") || alert.dueAt === null || alert.dueAt > now) return null;
  const ladder = parseLadder(alert.rule.escalation) ?? [{ level: alert.escalationLevel, role: alert.assigneeRole as EscalationRole, slaMinutes: 1 }];
  const i = rungIndex(ladder, alert.escalationLevel);
  const next = ladder[i + 1];
  const overdueMinutes = Math.floor((now.getTime() - alert.dueAt.getTime()) / MINUTE_MS);
  const base = { tenantId, subjectPersonId: alert.studentPersonId, entityType: "alert", entityId: alert.id };

  if (next) {
    const dueAt = new Date(now.getTime() + next.slaMinutes * MINUTE_MS);
    await tx.alert.update({ where: { id: alert.id }, data: { state: "escalated", escalationLevel: next.level, assigneeRole: next.role, dueAt, escalatedAt: now } });
    await tx.event.create({
      data: {
        ...base,
        type: "alert.escalated",
        payload: { ruleKey: alert.rule.key, fromLevel: alert.escalationLevel, toLevel: next.level, fromRole: alert.assigneeRole, toRole: next.role, slaMinutes: next.slaMinutes, overdueMinutes },
      },
    });
    return { alertId: alert.id, tenantId, action: "escalated", fromLevel: alert.escalationLevel, toLevel: next.level, fromRole: alert.assigneeRole, toRole: next.role, dueAt: dueAt.toISOString() };
  }
  // Last rung: record the breach once and stop the timer (the alert stays unresolved).
  await tx.alert.update({ where: { id: alert.id }, data: { dueAt: null } });
  await tx.event.create({
    data: { ...base, type: "alert.sla_expired", payload: { ruleKey: alert.rule.key, level: alert.escalationLevel, role: alert.assigneeRole, overdueMinutes } },
  });
  return { alertId: alert.id, tenantId, action: "sla_expired", fromLevel: alert.escalationLevel, toLevel: alert.escalationLevel, fromRole: alert.assigneeRole, toRole: alert.assigneeRole, dueAt: null };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Alerts of a tenant (default: unresolved), most urgent first. Owner or app role in withTenant. */
export function listAlerts(
  db: PrismaClient | Db,
  tenantId: string,
  opts: { states?: AlertState[]; assigneeRole?: string; studentPersonId?: string; severity?: AlertSeverity } = {},
) {
  return db.alert.findMany({
    where: {
      tenantId,
      state: { in: opts.states ?? [...UNRESOLVED_ALERT_STATES] },
      ...(opts.assigneeRole ? { assigneeRole: opts.assigneeRole } : {}),
      ...(opts.studentPersonId && isUuid(opts.studentPersonId) ? { studentPersonId: opts.studentPersonId } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
    },
    include: { rule: { select: { key: true, name: true } } },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { triggeredAt: "desc" }, { id: "asc" }],
  });
}
