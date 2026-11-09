import { createHmac } from "node:crypto";

import type {
  DeliveryStatus,
  OutboundMessage,
  ProviderAdapter,
  SendResult,
  WebhookEvent,
  WebhookRequest,
} from "../adapter";
import { resolveLocale, templateParams } from "../templates";
import {
  asArray,
  asRecord,
  constantTimeEqual,
  defaultFetch,
  type DriverOptions,
  type FetchLike,
  guardSend,
  header,
  httpError,
  safeJson,
  str,
} from "./http";

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  /** Meta app secret: signs every webhook (X-Hub-Signature-256). */
  appSecret: string;
  /** Token echoed during the GET subscription handshake. */
  verifyToken?: string;
  /** WhatsApp Business Account id — needed only to list templates. */
  businessAccountId?: string;
  apiVersion?: string;
  /** Prefix of the approved template names, e.g. "ssos_" -> "ssos_alert_critical". */
  templatePrefix?: string;
}

/** Cloud API error codes meaning the person cannot or does not want to receive from us. */
const OPT_OUT_ERROR_CODES = new Set([131050, 131026]);

const RECEIPT_STATUS: Record<string, DeliveryStatus | undefined> = { delivered: "delivered", read: "read", failed: "failed" };

/** HMAC-SHA256 of the raw body with the app secret, as Meta sends it. */
export function whatsappSignature(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

export class WhatsAppCloudDriver implements ProviderAdapter {
  readonly name = "whatsapp-cloud";
  readonly channel = "whatsapp" as const;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: WhatsAppConfig,
    options: DriverOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? (() => new Date());
  }

  private get base(): string {
    return `https://graph.facebook.com/${this.config.apiVersion ?? "v21.0"}`;
  }

  templateName(key: string): string {
    return `${this.config.templatePrefix ?? "ssos_"}${key.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return guardSend(async () => {
      const parameters = templateParams(message.template, message.variables).map((text) => ({ type: "text", text }));
      const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: this.templateName(message.template),
          language: { code: resolveLocale(message.locale) },
          components: parameters.length ? [{ type: "body", parameters }] : [],
        },
      };
      const res = await this.fetch(`${this.base}/${this.config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = asRecord(safeJson(await res.text()));
      if (!res.ok) {
        const err = asRecord(json.error);
        const code = typeof err.code === "number" ? err.code : 0;
        return httpError(res.status, `whatsapp_${code || res.status}`, str(err.message) ?? `HTTP ${res.status}`, OPT_OUT_ERROR_CODES.has(code));
      }
      const id = str(asRecord(asArray(json.messages)[0]).id);
      if (!id) return httpError(502, "whatsapp_no_id", "response carried no message id");
      return { ok: true, providerMessageId: id, acceptedAt: this.now() };
    });
  }

  /** Names of templates Meta has approved for this business account (template management). */
  async listApprovedTemplates(): Promise<string[]> {
    if (!this.config.businessAccountId) throw new Error("WHATSAPP_BUSINESS_ACCOUNT_ID is required to list templates");
    const res = await this.fetch(`${this.base}/${this.config.businessAccountId}/message_templates?status=APPROVED&limit=200`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!res.ok) throw new Error(`listing WhatsApp templates failed: HTTP ${res.status}`);
    const json = asRecord(safeJson(await res.text()));
    return asArray(json.data)
      .map((t) => asRecord(t))
      .filter((t) => t.status === "APPROVED")
      .map((t) => `${str(t.name) ?? ""}:${str(t.language) ?? ""}`);
  }

  /** GET handshake: returns the challenge to echo, or null to answer 403. */
  verifySubscription(query: Readonly<Record<string, string | undefined>>): string | null {
    const token = this.config.verifyToken;
    if (!token || query["hub.mode"] !== "subscribe" || !query["hub.verify_token"]) return null;
    return constantTimeEqual(query["hub.verify_token"], token) ? (query["hub.challenge"] ?? null) : null;
  }

  verifyWebhook(request: WebhookRequest): boolean {
    const given = header(request.headers, "x-hub-signature-256");
    if (!given) return false;
    return constantTimeEqual(given, whatsappSignature(request.rawBody, this.config.appSecret));
  }

  parseWebhook(request: WebhookRequest): WebhookEvent[] {
    const events: WebhookEvent[] = [];
    const root = asRecord(safeJson(request.rawBody));
    for (const entry of asArray(root.entry)) {
      for (const change of asArray(asRecord(entry).changes)) {
        const value = asRecord(asRecord(change).value);
        for (const m of asArray(value.messages).map(asRecord)) {
          const text =
            str(asRecord(m.text).body) ??
            str(asRecord(m.button).text) ??
            str(asRecord(asRecord(m.interactive).button_reply).title) ??
            "";
          const from = str(m.from);
          const id = str(m.id);
          if (!from || !id) continue;
          events.push({
            kind: "inbound",
            message: { channel: "whatsapp", from: `+${from.replace(/^\+/, "")}`, externalMessageId: id, text, receivedAt: unix(m.timestamp, this.now) },
          });
        }
        for (const s of asArray(value.statuses).map(asRecord)) {
          const status = RECEIPT_STATUS[str(s.status) ?? ""];
          const id = str(s.id);
          if (!status || !id) continue;
          const err = asRecord(asArray(s.errors)[0]);
          events.push({
            kind: "receipt",
            receipt: {
              channel: "whatsapp",
              providerMessageId: id,
              status,
              at: unix(s.timestamp, this.now),
              ...(status === "failed"
                ? {
                    error: {
                      code: `whatsapp_${str(err.code) ?? "failed"}`,
                      message: str(err.title) ?? str(err.message) ?? "delivery failed",
                      retryable: !OPT_OUT_ERROR_CODES.has(Number(err.code)),
                    },
                  }
                : {}),
            },
          });
        }
      }
    }
    return events;
  }
}

function unix(value: unknown, now: () => Date): Date {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : now();
}
