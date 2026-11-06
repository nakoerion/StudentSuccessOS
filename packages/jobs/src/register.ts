/**
 * Wire the handlers to pg-boss: queues, topic subscriptions, workers and cron schedules.
 * Typed against the small `BossLike` surface so a fake boss can verify the wiring.
 */
import { DOMAIN_EVENTS, type DomainEvent, QUEUES, SCHEDULES, studentQueueFor } from "./events";
import type { SuccessHandlers } from "./handlers";

export interface BossJob {
  id: string;
  data: unknown;
}

export interface BossLike {
  createQueue(name: string, options?: { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; expireInSeconds?: number }): Promise<void>;
  subscribe(event: string, name: string): Promise<void>;
  work(name: string, handler: (jobs: BossJob[]) => Promise<unknown>): Promise<string>;
  schedule(name: string, cron: string, data?: object | null, options?: { tz?: string }): Promise<void>;
}

/** Retries with backoff for transient DB errors; a recompute is idempotent. */
const RETRY = { retryLimit: 5, retryDelay: 30, retryBackoff: true } as const;

export interface Registration {
  queues: string[];
  subscriptions: { event: DomainEvent; queue: string }[];
  schedules: { queue: string; cron: string }[];
}

/** Run each job of a batch through `fn`; results come back in order (pg-boss stores them). */
const each = (fn: (data: unknown) => Promise<unknown>) => async (jobs: BossJob[]) => {
  const out: unknown[] = [];
  for (const job of jobs) out.push(await fn(job.data));
  return out.length === 1 ? out[0] : out;
};

export async function registerSuccessJobs(boss: BossLike, handlers: SuccessHandlers): Promise<Registration> {
  const reg: Registration = { queues: [], subscriptions: [], schedules: [] };

  for (const topic of DOMAIN_EVENTS) {
    const queue = studentQueueFor(topic);
    await boss.createQueue(queue, RETRY);
    await boss.subscribe(topic, queue);
    await boss.work(queue, each((data) => handlers.onStudentEvent(topic, data)));
    reg.queues.push(queue);
    reg.subscriptions.push({ event: topic, queue });
  }

  await boss.createQueue(QUEUES.recomputeTenant, { ...RETRY, expireInSeconds: 30 * 60 });
  await boss.work(QUEUES.recomputeTenant, each((data) => handlers.recomputeTenant(data)));
  reg.queues.push(QUEUES.recomputeTenant);

  await boss.createQueue(QUEUES.nightly, RETRY);
  await boss.work(QUEUES.nightly, each(() => handlers.nightly()));
  await boss.schedule(QUEUES.nightly, SCHEDULES.nightly, null, { tz: SCHEDULES.tz });
  reg.queues.push(QUEUES.nightly);
  reg.schedules.push({ queue: QUEUES.nightly, cron: SCHEDULES.nightly });

  await boss.createQueue(QUEUES.relay, { retryLimit: 0 });
  await boss.work(QUEUES.relay, each(() => handlers.relayDomainEvents()));
  await boss.schedule(QUEUES.relay, SCHEDULES.relay, null, { tz: SCHEDULES.tz });
  reg.queues.push(QUEUES.relay);
  reg.schedules.push({ queue: QUEUES.relay, cron: SCHEDULES.relay });

  return reg;
}
