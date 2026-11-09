import { createHmac } from "node:crypto";

import type { OutboundMessage, ProviderAdapter, SendResult, WebhookEvent, WebhookRequest } from "../adapter";
import { renderTemplate } from "../templates";
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

export interface ResendConfig {
  apiKey: string;
  /** Verified sender, e.g. "School <noreply@example.org>". */
  from: string;
  /** Svix signing secret of the Resend webhook ("whsec_..."). */
  webhookSecret: string;
}

/** Webhooks older or newer than this are replays. */
const TOLERANCE_SECONDS = 5 * 60;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Svix scheme used by Resend: base64 HMAC-SHA256 over "id.timestamp.body" with the decoded secret. */
export function svixSignature(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64")}`;
}

export class ResendEmailDriver implements ProviderAdapter {
  readonly name = "resend";
  readonly channel = "email" as const;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: ResendConfig,
    options: DriverOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? (() => new Date());
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return guardSend(async () => {
      const t = renderTemplate(message.template, message.locale, message.variables);
      const html = `<div dir="${t.dir}" lang="${t.locale}"><p>${escapeHtml(t.body).replace(/\n/g, "<br>")}</p></div>`;
      const res = await this.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
        },
        body: JSON.stringify({ from: this.config.from, to: [message.to], subject: t.subject, text: t.body, html }),
      });
      const json = asRecord(safeJson(await res.text()));
      if (!res.ok) return httpError(res.status, `resend_${str(json.name) ?? res.status}`, str(json.message) ?? `HTTP ${res.status}`);
      const id = str(json.id);
      if (!id) return httpError(502, "resend_no_id", "response carried no message id");
      return { ok: true, providerMessageId: id, acceptedAt: this.now() };
    });
  }

  verifyWebhook(request: WebhookRequest): boolean {
    const id = header(request.headers, "svix-id");
    const timestamp = header(request.headers, "svix-timestamp");
    const signatures = header(request.headers, "svix-signature");
    if (!id || !timestamp || !signatures) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.now().getTime() / 1000 - ts) > TOLERANCE_SECONDS) return false;
    const expected = svixSignature(this.config.webhookSecret, id, timestamp, request.rawBody);
    return signatures.split(" ").some((s) => constantTimeEqual(s, expected));
  }

  parseWebhook(request: WebhookRequest): WebhookEvent[] {
    const root = asRecord(safeJson(request.rawBody));
    const data = asRecord(root.data);
    const type = str(root.type);
    const at = new Date(str(root.created_at) ?? this.now().toISOString());
    const emailId = str(data.email_id);
    const recipient = str(asArray(data.to)[0]);
    switch (type) {
      case "email.delivered":
        return emailId ? [{ kind: "receipt", receipt: { channel: "email", providerMessageId: emailId, status: "delivered", at } }] : [];
      case "email.opened":
        return emailId ? [{ kind: "receipt", receipt: { channel: "email", providerMessageId: emailId, status: "read", at } }] : [];
      case "email.bounced": {
        const bounce = asRecord(data.bounce);
        const permanent = str(bounce.type) !== "Transient";
        return emailId
          ? [
              {
                kind: "receipt",
                receipt: {
                  channel: "email",
                  providerMessageId: emailId,
                  status: "failed",
                  at,
                  error: { code: "resend_bounced", message: str(bounce.message) ?? "bounced", retryable: !permanent },
                },
              },
            ]
          : [];
      }
      case "email.complained":
        return recipient ? [{ kind: "opt_out", optOut: { channel: "email", externalId: recipient.toLowerCase(), reason: "spam complaint", at } }] : [];
      case "email.received": {
        const from = str(data.from);
        const address = from?.match(/<([^>]+)>/)?.[1] ?? from;
        if (!address || !emailId) return [];
        const text = str(data.text) ?? str(data.subject) ?? "";
        return [{ kind: "inbound", message: { channel: "email", from: address.toLowerCase(), externalMessageId: emailId, text, receivedAt: at } }];
      }
      default:
        return [];
    }
  }
}
