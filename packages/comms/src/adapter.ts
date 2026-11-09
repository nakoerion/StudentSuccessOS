/**
 * The one provider seam. Every external channel (WhatsApp Business, Telegram, e-mail,
 * SMS, Web Push) is a `ProviderAdapter`; the outbox worker only ever talks to this
 * interface. Real drivers read their credentials from env and arrive in the next slice;
 * tests use `FakeDriver` (./fake.ts) so the suite never needs live credentials.
 */

/** Mirrors the `comm_channel` Postgres enum. */
export const CHANNELS = ["whatsapp", "telegram", "email", "sms", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One rendered-or-templated message to one external address. */
export interface OutboundMessage {
  /** Outbox row id — providers that support it use it to de-duplicate retries. */
  idempotencyKey: string;
  channel: Channel;
  /** channel_binding.external_id: E.164 phone, Telegram chat id, e-mail, push endpoint. */
  to: string;
  /** Template key, e.g. "digest.weekly", "alert.critical". */
  template: string;
  /** sq | en | ar. */
  locale: string;
  variables: Readonly<Record<string, unknown>>;
  /** Channel extras from channel_binding.meta (e.g. Web Push keys). */
  meta?: Readonly<Record<string, unknown>>;
}

export interface SendError {
  /** Provider or transport error code. */
  code: string;
  message: string;
  /** false = retrying cannot help (bad address, recipient opted out, template rejected). */
  retryable: boolean;
  /** The recipient is gone or has blocked us (blocked bot, expired push subscription, unsubscribed number): unbind them. */
  optOut?: boolean;
}

export type SendResult =
  | { ok: true; providerMessageId: string; acceptedAt: Date }
  | { ok: false; error: SendError };

/** A raw webhook call, exactly as received (signatures are computed over the raw body). */
export interface WebhookRequest {
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: string;
}

export interface InboundMessage {
  channel: Channel;
  /** Sender's external id — matched against channel_binding.external_id. */
  from: string;
  externalMessageId: string;
  text: string;
  receivedAt: Date;
}

export type DeliveryStatus = "delivered" | "read" | "failed";

export interface DeliveryReceipt {
  channel: Channel;
  providerMessageId: string;
  status: DeliveryStatus;
  at: Date;
  error?: SendError;
}

/** A provider-level opt-out (spam complaint, unsubscribe event) — distinct from a STOP text reply. */
export interface OptOutEvent {
  channel: Channel;
  externalId: string;
  reason: string;
  at: Date;
}

export type WebhookEvent =
  | { kind: "inbound"; message: InboundMessage }
  | { kind: "receipt"; receipt: DeliveryReceipt }
  | { kind: "opt_out"; optOut: OptOutEvent };

export interface ProviderAdapter {
  /** Driver name for logs, e.g. "whatsapp-cloud", "fake". */
  readonly name: string;
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Channels with inbound traffic or receipts implement both webhook methods. */
  verifyWebhook?(request: WebhookRequest): boolean;
  /** Only called after verifyWebhook returned true. */
  parseWebhook?(request: WebhookRequest): WebhookEvent[];
}

/** The adapter configured for each channel (absent = channel unavailable for this deployment). */
export type ProviderRegistry = Partial<Record<Channel, ProviderAdapter>>;
