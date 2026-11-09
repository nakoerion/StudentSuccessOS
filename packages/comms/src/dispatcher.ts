import type {
  Channel,
  DeliveryReceipt,
  InboundMessage,
  OptOutEvent,
  ProviderRegistry,
  SendResult,
  WebhookRequest,
} from "./adapter";
import { canTransition, outcomeOfSend, type OutboxState, retryDelayMs } from "./outbox-state";
import { isStopKeyword } from "./stop";

export type OptInState = "pending" | "opted_in" | "opted_out";

export interface OutboxRecipient {
  externalId: string;
  optInState: OptInState;
  meta: Readonly<Record<string, unknown>>;
}

/** An outbox row joined with its channel binding — what the dispatcher needs to send. */
export interface OutboxRow {
  id: string;
  channel: Channel;
  template: string;
  locale: string;
  payload: Readonly<Record<string, unknown>>;
  state: OutboxState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  idempotencyKey: string | null;
  recipient: OutboxRecipient | null;
}

export interface OutboxPatch {
  state: OutboxState;
  attempts?: number;
  nextAttemptAt?: Date;
  lastError?: string | null;
  providerMessageId?: string;
  sentAt?: Date;
  deliveredAt?: Date;
}

/**
 * Persistence port. `transition` is a compare-and-set: it applies the patch only while
 * the row still has the expected state and attempt count, so two workers never send the
 * same row twice. The Postgres store lives in @ssos/db; MemoryOutboxStore is for tests.
 */
export interface OutboxStore {
  /** queued or failed rows whose next_attempt_at has passed, oldest first. */
  due(now: Date, limit: number): Promise<OutboxRow[]>;
  transition(id: string, expected: { state: OutboxState; attempts: number }, patch: OutboxPatch): Promise<boolean>;
  findByProviderMessageId(channel: Channel, providerMessageId: string): Promise<OutboxRow | null>;
  /** Mark every binding of this address on this channel opted out; returns how many changed. */
  optOut(channel: Channel, externalId: string, at: Date): Promise<number>;
}

export type DispatchResult = "sent" | "failed" | "dead" | "cancelled" | "skipped";

export interface DispatchSummary {
  sent: number;
  failed: number;
  dead: number;
  cancelled: number;
  skipped: number;
}

export interface WebhookOutcome {
  accepted: boolean;
  /** Ordinary replies, to be routed to the student's thread. */
  inbound: InboundMessage[];
  receiptsApplied: number;
  optOuts: OptOutEvent[];
}

export interface DispatcherOptions {
  now?: () => Date;
  batchSize?: number;
}

export class OutboxDispatcher {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly providers: ProviderRegistry,
    options: DispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 50;
  }

  /** Send every due row once. Safe to run concurrently: claims are compare-and-set. */
  async dispatchDue(): Promise<DispatchSummary> {
    const summary: DispatchSummary = { sent: 0, failed: 0, dead: 0, cancelled: 0, skipped: 0 };
    for (const row of await this.store.due(this.now(), this.batchSize)) summary[await this.dispatchOne(row)]++;
    return summary;
  }

  async dispatchOne(row: OutboxRow): Promise<DispatchResult> {
    if (row.state !== "queued" && row.state !== "failed") return "skipped";
    const expected = { state: row.state, attempts: row.attempts };

    // Never send to someone without an opted-in binding on this channel.
    if (!row.recipient || row.recipient.optInState !== "opted_in") {
      const reason = row.recipient ? `recipient_${row.recipient.optInState}` : "no_channel_binding";
      return (await this.store.transition(row.id, expected, { state: "cancelled", lastError: reason })) ? "cancelled" : "skipped";
    }

    const attempts = row.attempts + 1;
    if (!(await this.store.transition(row.id, expected, { state: "sending", attempts }))) return "skipped";
    const sending = { state: "sending" as const, attempts };

    const provider = this.providers[row.channel];
    const result: SendResult = provider
      ? await provider.send({
          idempotencyKey: row.idempotencyKey ?? row.id,
          channel: row.channel,
          to: row.recipient.externalId,
          template: row.template,
          locale: row.locale,
          variables: row.payload,
          meta: row.recipient.meta,
        })
      : { ok: false, error: { code: "no_provider", message: `no provider configured for ${row.channel}`, retryable: false } };

    const now = this.now();
    if (!result.ok && result.error.optOut) await this.store.optOut(row.channel, row.recipient.externalId, now);

    const outcome = outcomeOfSend(result, attempts, row.maxAttempts, now);
    switch (outcome.state) {
      case "sent":
        await this.store.transition(row.id, sending, {
          state: "sent",
          providerMessageId: outcome.providerMessageId,
          sentAt: outcome.sentAt,
          lastError: null,
        });
        return "sent";
      case "failed":
        await this.store.transition(row.id, sending, { state: "failed", lastError: outcome.lastError, nextAttemptAt: outcome.nextAttemptAt });
        return "failed";
      case "dead":
        await this.store.transition(row.id, sending, { state: "dead", lastError: outcome.lastError });
        return "dead";
    }
  }

  /** Apply a provider delivery receipt to its outbox row. Returns false when nothing changed. */
  async applyReceipt(receipt: DeliveryReceipt): Promise<boolean> {
    const row = await this.store.findByProviderMessageId(receipt.channel, receipt.providerMessageId);
    if (!row || row.state !== "sent") return false;
    const expected = { state: row.state, attempts: row.attempts };
    if (receipt.status === "delivered" || receipt.status === "read") {
      return this.store.transition(row.id, expected, { state: "delivered", deliveredAt: receipt.at });
    }
    const error = receipt.error ?? { code: "delivery_failed", message: "provider reported failure", retryable: true };
    const lastError = `${error.code}: ${error.message}`;
    const retry = error.retryable && row.attempts < row.maxAttempts;
    const nextAttemptAt = new Date(receipt.at.getTime() + retryDelayMs(row.attempts));
    if (!(await this.store.transition(row.id, expected, { state: "failed", lastError, nextAttemptAt }))) return false;
    if (!retry) await this.store.transition(row.id, { state: "failed", attempts: row.attempts }, { state: "dead", lastError });
    return true;
  }

  /**
   * Verify, parse and apply one provider webhook. A STOP reply (en/sq/ar) on any channel
   * opts the sender out and is not routed as a message; receipts update delivery states.
   */
  async handleWebhook(channel: Channel, request: WebhookRequest): Promise<WebhookOutcome> {
    const outcome: WebhookOutcome = { accepted: false, inbound: [], receiptsApplied: 0, optOuts: [] };
    const provider = this.providers[channel];
    if (!provider?.verifyWebhook || !provider.parseWebhook || !provider.verifyWebhook(request)) return outcome;
    outcome.accepted = true;
    for (const event of provider.parseWebhook(request)) {
      if (event.kind === "receipt") {
        if (await this.applyReceipt(event.receipt)) outcome.receiptsApplied++;
      } else if (event.kind === "opt_out") {
        await this.store.optOut(event.optOut.channel, event.optOut.externalId, event.optOut.at);
        outcome.optOuts.push(event.optOut);
      } else if (isStopKeyword(event.message.text)) {
        const m = event.message;
        await this.store.optOut(m.channel, m.from, m.receivedAt);
        outcome.optOuts.push({ channel: m.channel, externalId: m.from, reason: `keyword: ${m.text.trim()}`, at: m.receivedAt });
      } else {
        outcome.inbound.push(event.message);
      }
    }
    return outcome;
  }
}

/** In-memory OutboxStore that enforces the same lifecycle as the Postgres trigger. */
export class MemoryOutboxStore implements OutboxStore {
  readonly rows = new Map<string, OutboxRow & { lastError: string | null; providerMessageId: string | null; sentAt: Date | null; deliveredAt: Date | null }>();
  readonly optOuts: { channel: Channel; externalId: string; at: Date }[] = [];

  add(row: Omit<OutboxRow, "state" | "attempts" | "nextAttemptAt" | "maxAttempts"> & Partial<Pick<OutboxRow, "nextAttemptAt" | "maxAttempts">>): this {
    this.rows.set(row.id, {
      maxAttempts: 5,
      nextAttemptAt: new Date(0),
      ...row,
      state: "queued",
      attempts: 0,
      lastError: null,
      providerMessageId: null,
      sentAt: null,
      deliveredAt: null,
    });
    return this;
  }

  get(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no outbox row ${id}`);
    return row;
  }

  async due(now: Date, limit: number): Promise<OutboxRow[]> {
    return [...this.rows.values()]
      .filter((r) => (r.state === "queued" || r.state === "failed") && r.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async transition(id: string, expected: { state: OutboxState; attempts: number }, patch: OutboxPatch): Promise<boolean> {
    const row = this.get(id);
    if (row.state !== expected.state || row.attempts !== expected.attempts) return false;
    if (!canTransition(row.state, patch.state)) throw new Error(`outbox_lifecycle: illegal transition ${row.state} -> ${patch.state}`);
    const attempts = patch.attempts ?? row.attempts;
    if (attempts !== row.attempts + (patch.state === "sending" ? 1 : 0)) throw new Error("outbox_lifecycle: attempts only grow by one on each move into sending");
    Object.assign(row, patch, { attempts });
    return true;
  }

  async findByProviderMessageId(channel: Channel, providerMessageId: string): Promise<OutboxRow | null> {
    const row = [...this.rows.values()].find((r) => r.channel === channel && r.providerMessageId === providerMessageId);
    return row ? { ...row } : null;
  }

  async optOut(channel: Channel, externalId: string, at: Date): Promise<number> {
    this.optOuts.push({ channel, externalId, at });
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.channel === channel && row.recipient?.externalId === externalId && row.recipient.optInState !== "opted_out") {
        row.recipient = { ...row.recipient, optInState: "opted_out" };
        n++;
      }
    }
    return n;
  }
}
