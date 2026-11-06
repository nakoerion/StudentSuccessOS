/**
 * Domain events the success engine listens to, and the queues it owns.
 *
 * Producers never talk to the queue: every mutation already writes one `event` row in its
 * own transaction (the platform invariant), so the `event` table IS the outbox. The relay
 * (handlers.ts → relayDomainEvents) maps event-row types to the topics below and publishes
 * them through pg-boss; subscribers recompute only the affected student.
 */

/** Topics (pg-boss pub/sub event names). */
export const DOMAIN_EVENTS = ["student.graded", "attendance.marked", "submission.late", "note.created"] as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

/**
 * `event.type` → topic. `grade_entry.created` and `attendance.recorded` are written by the
 * gradebook and attendance services today. `submission.late` and `note.created` have no
 * producer until the assignments/notes slice lands; the relay and the subscribers already
 * handle them, so they start firing the moment those rows appear — until then they are no-ops.
 */
export const EVENT_TYPE_TOPICS: Readonly<Record<string, DomainEvent>> = {
  "grade_entry.created": "student.graded",
  "attendance.recorded": "attendance.marked",
  "submission.late": "submission.late",
  "note.created": "note.created",
};

/** Queue that receives a topic for the success engine (one subscriber queue per topic). */
export const studentQueueFor = (topic: DomainEvent) => `success.on.${topic}` as const;

export const QUEUES = {
  /** Cron: read new `event` rows and publish their topics. */
  relay: "success.relay-events",
  /** Cron: nightly — fan out one tenant recompute per tenant. */
  nightly: "success.nightly-recompute",
  /** One full recompute (+ track proposals, + expiry of stale cards) of one tenant. */
  recomputeTenant: "success.recompute-tenant",
  /** Cron: advance alerts whose SLA elapsed one rung up the escalation ladder. */
  escalateAlerts: "success.escalate-alerts",
  /** Cron: the week's nudge for every active goal (idempotent: one per goal per ISO week). */
  goalNudges: "success.goal-nudges",
} as const;

export const SCHEDULES = {
  /** Every minute (pg-boss's finest cron granularity). */
  relay: "* * * * *",
  /** 01:00 UTC — night in every country we serve (02:00 Tirana, 05:00 Abu Dhabi). */
  nightly: "0 1 * * *",
  /** Every minute: SLA timers are in minutes; an alert never moves before its due_at. */
  escalateAlerts: "* * * * *",
  /** Daily 06:00 UTC; the first run of each ISO week sends that week's nudge, later runs are no-ops. */
  goalNudges: "0 6 * * *",
  tz: "UTC",
} as const;

/** Payload of every student topic. */
export interface StudentEventPayload {
  tenantId: string;
  studentPersonId: string;
  /** The `event` row the topic was relayed from (also the job id, for dedupe). */
  eventId?: string;
  /** The `event.type` it came from. */
  sourceType?: string;
}

export interface TenantJobPayload {
  tenantId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Validate a student-topic payload; null when it is unusable (the job is then skipped, not retried). */
export function parseStudentEventPayload(raw: unknown): StudentEventPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isUuid(o.tenantId) || !isUuid(o.studentPersonId)) return null;
  return {
    tenantId: o.tenantId,
    studentPersonId: o.studentPersonId,
    ...(isUuid(o.eventId) ? { eventId: o.eventId } : {}),
    ...(typeof o.sourceType === "string" ? { sourceType: o.sourceType } : {}),
  };
}

export function parseTenantJobPayload(raw: unknown): TenantJobPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return isUuid(o.tenantId) ? { tenantId: o.tenantId } : null;
}
