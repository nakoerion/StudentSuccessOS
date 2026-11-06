/**
 * Job handlers of the success engine — plain async functions over an OWNER Prisma client.
 * They know nothing about pg-boss: `register.ts` adapts them to queues, and tests call
 * them directly (no live queue needed). Every handler is idempotent and safe to retry.
 */
import { expireStaleActionCards, type Prisma, type PrismaClient, recomputeStudentRisk, recomputeTenantRisk, RiskModelError, type TrackProposalResult } from "@ssos/db";

import {
  type DomainEvent,
  EVENT_TYPE_TOPICS,
  parseStudentEventPayload,
  parseTenantJobPayload,
  QUEUES,
  type StudentEventPayload,
  type TenantJobPayload,
} from "./events";

export interface JobDeps {
  /** OWNER client (DATABASE_ADMIN_URL): risk_score and risk_model_config are engine-owned.
   * Tests may pass an owner transaction instead (then everything runs inside it). */
  db: PrismaClient | Prisma.TransactionClient;
  /** Publish a topic to its subscribers; `id` makes the publish idempotent (job id). */
  publish: (topic: DomainEvent, data: StudentEventPayload, options: { id: string }) => Promise<unknown>;
  /** Enqueue one job on a queue. */
  send: (queue: string, data: object) => Promise<unknown>;
  /** Relay: only events older than this are read, so a producer transaction that started
   * earlier but commits later is never skipped (`created_at` = transaction start).
   * Must exceed the longest producer transaction (default 150 s > the 120 s recompute cap). */
  relaySettleSeconds?: number;
  relayBatchSize?: number;
  /** Clock; also the data cut-off (`asOf`) of the recomputes. Default: wall clock. */
  now?: () => Date;
}

function isClient(db: JobDeps["db"]): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}

export const RELAY_CURSOR = "domain-events";

export type StudentJobResult =
  | { status: "scored"; tenantId: string; studentPersonId: string; riskScoreId: string; score: number; proposal: TrackProposalResult | null }
  | { status: "insufficient_data"; tenantId: string; studentPersonId: string }
  | { status: "skipped"; reason: string; topic: DomainEvent };

export interface TenantJobResult {
  status: "recomputed" | "skipped";
  tenantId?: string;
  reason?: string;
  expiredCards?: number;
  students?: number;
  scored?: number;
  proposals?: Record<string, number>;
}

export interface RelayResult {
  scanned: number;
  published: number;
  /** Rows with no subject student (nothing to recompute). */
  skipped: number;
  cursor: { createdAt: string; id: string } | null;
}

/** Errors that mean "nothing to recompute for this student" — not worth a retry. */
const SKIPPABLE = new Set(["unknown_student", "not_enrolled", "no_active_config"]);

export function createHandlers(deps: JobDeps) {
  const { db } = deps;
  const settle = deps.relaySettleSeconds ?? 150;
  const batch = deps.relayBatchSize ?? 500;

  /**
   * Any student topic: recompute ONLY that student's risk (one risk_score row) and let the
   * recompute propose a track transition as an action card. Never changes a track.
   */
  async function onStudentEvent(topic: DomainEvent, raw: unknown): Promise<StudentJobResult> {
    const payload = parseStudentEventPayload(raw);
    if (!payload) return { status: "skipped", reason: "invalid_payload", topic };
    try {
      const asOf = deps.now?.();
      const r = await recomputeStudentRisk(db, { tenantId: payload.tenantId, studentPersonId: payload.studentPersonId, ...(asOf ? { asOf } : {}) });
      if (r.status === "insufficient_data") return { status: "insufficient_data", tenantId: payload.tenantId, studentPersonId: payload.studentPersonId };
      return {
        status: "scored",
        tenantId: payload.tenantId,
        studentPersonId: payload.studentPersonId,
        riskScoreId: r.riskScore.id,
        score: r.riskScore.score,
        proposal: r.proposal,
      };
    } catch (e) {
      if (e instanceof RiskModelError && SKIPPABLE.has(e.code)) return { status: "skipped", reason: e.code, topic };
      throw e;
    }
  }

  /** One tenant: expire undecided cards past their date, then a full recompute (+ proposals). */
  async function recomputeTenant(raw: unknown): Promise<TenantJobResult> {
    const payload: TenantJobPayload | null = parseTenantJobPayload(raw);
    if (!payload) return { status: "skipped", reason: "invalid_payload" };
    const now = deps.now?.() ?? new Date();
    try {
      const expiredCards = await expireStaleActionCards(db, { tenantId: payload.tenantId, now });
      const r = await recomputeTenantRisk(db, { tenantId: payload.tenantId, ...(deps.now ? { asOf: now } : {}) });
      return { status: "recomputed", tenantId: payload.tenantId, expiredCards, students: r.students, scored: r.scored, proposals: r.proposals };
    } catch (e) {
      if (e instanceof RiskModelError && e.code === "no_active_config") return { status: "skipped", tenantId: payload.tenantId, reason: e.code };
      throw e;
    }
  }

  /** Nightly: one recompute-tenant job per tenant with an active risk model. */
  async function nightly(): Promise<{ tenants: number }> {
    const rows = await db.riskModelConfig.findMany({ where: { isActive: true }, select: { tenantId: true }, orderBy: { tenantId: "asc" } });
    for (const r of rows) await deps.send(QUEUES.recomputeTenant, { tenantId: r.tenantId } satisfies TenantJobPayload);
    return { tenants: rows.length };
  }

  /**
   * Outbox relay: read `event` rows of the mapped types after the cursor (and older than the
   * settle window), publish one topic per row with the event id as job id, then advance the
   * cursor — one transaction, serialised by an advisory lock. A crash after publishing
   * re-publishes the same ids, which pg-boss ignores.
   */
  async function relayDomainEvents(): Promise<RelayResult> {
    const types = Object.keys(EVENT_TYPE_TOPICS);
    const run = async (tx: Prisma.TransactionClient): Promise<RelayResult> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ssos:jobs:relay'))`;
        let [cur] = await tx.$queryRaw<{ last_created_at: Date; last_id: string }[]>`
          SELECT last_created_at, last_id::text FROM ssos_jobs.relay_cursor WHERE name = ${RELAY_CURSOR} FOR UPDATE`;
        if (!cur) {
          // First run: start at the settle horizon. Older history is covered by the nightly recompute.
          [cur] = await tx.$queryRaw<{ last_created_at: Date; last_id: string }[]>`
            INSERT INTO ssos_jobs.relay_cursor (name, last_created_at, last_id)
            VALUES (${RELAY_CURSOR}, now() - make_interval(secs => ${settle}), '00000000-0000-0000-0000-000000000000')
            RETURNING last_created_at, last_id::text`;
        }
        const rows = await tx.$queryRaw<{ id: string; tenant_id: string; type: string; subject_person_id: string | null; created_at: Date }[]>`
          SELECT id::text, tenant_id::text, type, subject_person_id::text, created_at
            FROM event
           WHERE type = ANY(${types}::text[])
             AND (created_at, id) > (${cur!.last_created_at}::timestamptz, ${cur!.last_id}::uuid)
             AND created_at < now() - make_interval(secs => ${settle})
           ORDER BY created_at, id
           LIMIT ${batch}`;
        let published = 0;
        for (const row of rows) {
          if (!row.subject_person_id) continue;
          const topic = EVENT_TYPE_TOPICS[row.type]!;
          await deps.publish(topic, { tenantId: row.tenant_id, studentPersonId: row.subject_person_id, eventId: row.id, sourceType: row.type }, { id: row.id });
          published += 1;
        }
        const last = rows.at(-1);
        if (last) {
          await tx.$executeRaw`
            UPDATE ssos_jobs.relay_cursor SET last_created_at = ${last.created_at}, last_id = ${last.id}::uuid, updated_at = now()
             WHERE name = ${RELAY_CURSOR}`;
        }
        const c = last ?? { created_at: cur!.last_created_at, id: cur!.last_id };
        return { scanned: rows.length, published, skipped: rows.length - published, cursor: { createdAt: c.created_at.toISOString(), id: c.id } };
    };
    return isClient(db) ? db.$transaction(run, { timeout: 120_000, maxWait: 30_000 }) : run(db);
  }

  return { onStudentEvent, recomputeTenant, nightly, relayDomainEvents };
}

export type SuccessHandlers = ReturnType<typeof createHandlers>;

/** Move the relay cursor (ops/tests): the next run reads events after `at`. OWNER client. */
export async function setRelayCursor(db: PrismaClient | Prisma.TransactionClient, at: Date): Promise<void> {
  await db.$executeRaw`
    INSERT INTO ssos_jobs.relay_cursor (name, last_created_at, last_id) VALUES (${RELAY_CURSOR}, ${at}, '00000000-0000-0000-0000-000000000000')
    ON CONFLICT (name) DO UPDATE SET last_created_at = EXCLUDED.last_created_at, last_id = EXCLUDED.last_id, updated_at = now()`;
}
