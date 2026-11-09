import type { SendResult } from "./adapter";

/** Mirrors the `outbox_state` Postgres enum. */
export const OUTBOX_STATES = ["queued", "sending", "sent", "delivered", "failed", "dead", "cancelled"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/**
 * Legal moves — the same table the `outbox_state_guard` trigger enforces in Postgres,
 * so the worker can decide before it writes and the database refuses anything else.
 */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxState, readonly OutboxState[]>> = {
  queued: ["sending", "cancelled"],
  sending: ["sent", "failed", "dead"],
  sent: ["delivered", "failed"],
  failed: ["sending", "dead", "cancelled"],
  delivered: [],
  dead: [],
  cancelled: [],
};

export const FINAL_OUTBOX_STATES: readonly OutboxState[] = ["delivered", "dead", "cancelled"];

export function canTransition(from: OutboxState, to: OutboxState): boolean {
  return OUTBOX_TRANSITIONS[from].includes(to);
}

/** Exponential retry backoff: 1, 2, 4, 8 ... minutes, capped at 1 hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

export type SendOutcome =
  | { state: "sent"; providerMessageId: string; sentAt: Date }
  | { state: "failed"; lastError: string; nextAttemptAt: Date }
  | { state: "dead"; lastError: string };

/**
 * What a `sending` row becomes after the provider answered. `attempts` already counts
 * the attempt that just ran. Non-retryable errors and the last allowed attempt are dead.
 */
export function outcomeOfSend(result: SendResult, attempts: number, maxAttempts: number, now: Date): SendOutcome {
  if (result.ok) return { state: "sent", providerMessageId: result.providerMessageId, sentAt: result.acceptedAt };
  const lastError = `${result.error.code}: ${result.error.message}`;
  if (!result.error.retryable || attempts >= maxAttempts) return { state: "dead", lastError };
  return { state: "failed", lastError, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) };
}
