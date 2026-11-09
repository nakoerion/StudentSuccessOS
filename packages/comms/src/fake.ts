import { createHmac, timingSafeEqual } from "node:crypto";

import {
  CHANNELS,
  type Channel,
  type OutboundMessage,
  type ProviderAdapter,
  type ProviderRegistry,
  type SendError,
  type SendResult,
  type WebhookEvent,
  type WebhookRequest,
} from "./adapter";

export interface SentRecord {
  message: OutboundMessage;
  result: SendResult;
  at: Date;
}

export type FailurePlan = Partial<SendError> | ((message: OutboundMessage) => Partial<SendError> | null);

const SIGNATURE_HEADER = "x-fake-signature";

/**
 * In-memory driver for tests. Records every send attempt (successes and simulated
 * failures) and can simulate provider failures: queue N failures with `failNext`, or
 * fail selectively with `failWhen`. Webhooks are HMAC-SHA256 signed with a test secret,
 * so the verify/parse path of the outbox worker can be exercised end to end.
 */
export class FakeDriver implements ProviderAdapter {
  readonly name = "fake";
  readonly sent: SentRecord[] = [];
  private queuedFailures: Partial<SendError>[] = [];
  private failurePredicate: ((message: OutboundMessage) => Partial<SendError> | null) | null = null;
  private counter = 0;

  constructor(
    readonly channel: Channel,
    private readonly options: { webhookSecret?: string; now?: () => Date } = {},
  ) {}

  /** Make the next `count` sends fail (default: retryable "fake_unavailable"). */
  failNext(count = 1, error: Partial<SendError> = {}): this {
    for (let i = 0; i < count; i++) this.queuedFailures.push(error);
    return this;
  }

  /** Fail every send for which `plan` returns an error (null = succeed). */
  failWhen(plan: FailurePlan): this {
    this.failurePredicate = typeof plan === "function" ? plan : () => plan;
    return this;
  }

  reset(): void {
    this.sent.length = 0;
    this.queuedFailures = [];
    this.failurePredicate = null;
  }

  /** Successful sends only. */
  get delivered(): OutboundMessage[] {
    return this.sent.filter((r) => r.result.ok).map((r) => r.message);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const at = this.now();
    const failure = this.queuedFailures.shift() ?? this.failurePredicate?.(message) ?? null;
    const result: SendResult = failure
      ? {
          ok: false,
          error: {
            code: failure.code ?? "fake_unavailable",
            message: failure.message ?? "simulated provider failure",
            retryable: failure.retryable ?? true,
          },
        }
      : { ok: true, providerMessageId: `fake-${this.channel}-${++this.counter}`, acceptedAt: at };
    this.sent.push({ message, result, at });
    return result;
  }

  /** Build a correctly signed webhook request carrying `events` (for inbound/receipt tests). */
  webhook(events: WebhookEvent[]): WebhookRequest {
    const rawBody = JSON.stringify(events);
    return { headers: { [SIGNATURE_HEADER]: this.sign(rawBody) }, rawBody };
  }

  verifyWebhook(request: WebhookRequest): boolean {
    const given = request.headers[SIGNATURE_HEADER];
    if (!given) return false;
    const expected = Buffer.from(this.sign(request.rawBody));
    const actual = Buffer.from(given);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  parseWebhook(request: WebhookRequest): WebhookEvent[] {
    const events = JSON.parse(request.rawBody) as WebhookEvent[];
    // JSON turns dates into strings; restore them.
    return events.map((e) =>
      e.kind === "inbound"
        ? { kind: "inbound", message: { ...e.message, receivedAt: new Date(e.message.receivedAt) } }
        : { kind: "receipt", receipt: { ...e.receipt, at: new Date(e.receipt.at) } },
    );
  }

  private sign(rawBody: string): string {
    return createHmac("sha256", this.options.webhookSecret ?? "fake-webhook-secret").update(rawBody).digest("hex");
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** A fake driver on every channel. */
export function fakeProviders(options?: ConstructorParameters<typeof FakeDriver>[1]): Record<Channel, FakeDriver> & ProviderRegistry {
  return Object.fromEntries(CHANNELS.map((c) => [c, new FakeDriver(c, options)])) as Record<Channel, FakeDriver>;
}
