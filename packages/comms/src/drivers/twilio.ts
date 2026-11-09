import { createHmac } from "node:crypto";

import type { DeliveryStatus, OutboundMessage, ProviderAdapter, SendResult, WebhookEvent, WebhookRequest } from "../adapter";
import { OPT_OUT_HINT, renderTemplate } from "../templates";
import {
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

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Sender number (E.164) or a Messaging Service SID ("MG..."). */
  from: string;
  /** Public URL Twilio posts inbound SMS and status callbacks to — part of the signature. */
  webhookUrl?: string;
}

/** Twilio: 21610 = recipient replied STOP, 21614 = not a mobile number. */
const OPT_OUT_ERRORS = new Set([21610]);
const PERMANENT_ERRORS = new Set([21610, 21211, 21614, 21408]);

const STATUS: Record<string, DeliveryStatus | undefined> = { delivered: "delivered", read: "read", undelivered: "failed", failed: "failed" };

/** X-Twilio-Signature: base64 HMAC-SHA1 of the URL followed by each sorted POST param name+value. */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export class TwilioSmsDriver implements ProviderAdapter {
  readonly name = "twilio-sms";
  readonly channel = "sms" as const;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: TwilioConfig,
    options: DriverOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? (() => new Date());
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return guardSend(async () => {
      const t = renderTemplate(message.template, message.locale, message.variables);
      const form = new URLSearchParams({ To: message.to, Body: `${t.body} ${OPT_OUT_HINT[t.locale]}` });
      if (this.config.from.startsWith("MG")) form.set("MessagingServiceSid", this.config.from);
      else form.set("From", this.config.from);
      if (this.config.webhookUrl) form.set("StatusCallback", this.config.webhookUrl);
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
      const res = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const json = asRecord(safeJson(await res.text()));
      if (!res.ok) {
        const code = Number(json.code);
        const result = httpError(res.status, `twilio_${Number.isFinite(code) ? code : res.status}`, str(json.message) ?? `HTTP ${res.status}`, OPT_OUT_ERRORS.has(code));
        if (!result.ok && PERMANENT_ERRORS.has(code)) result.error.retryable = false;
        return result;
      }
      const sid = str(json.sid);
      if (!sid) return httpError(502, "twilio_no_sid", "response carried no message sid");
      return { ok: true, providerMessageId: sid, acceptedAt: this.now() };
    });
  }

  verifyWebhook(request: WebhookRequest): boolean {
    const given = header(request.headers, "x-twilio-signature");
    if (!given || !this.config.webhookUrl) return false;
    const params = Object.fromEntries(new URLSearchParams(request.rawBody));
    return constantTimeEqual(given, twilioSignature(this.config.authToken, this.config.webhookUrl, params));
  }

  parseWebhook(request: WebhookRequest): WebhookEvent[] {
    const p = Object.fromEntries(new URLSearchParams(request.rawBody));
    const sid = p.MessageSid ?? p.SmsSid;
    if (!sid) return [];
    const status = p.MessageStatus ? STATUS[p.MessageStatus] : undefined;
    if (p.MessageStatus && p.MessageStatus !== "received") {
      if (!status) return [];
      const code = Number(p.ErrorCode);
      return [
        {
          kind: "receipt",
          receipt: {
            channel: "sms",
            providerMessageId: sid,
            status,
            at: this.now(),
            ...(status === "failed"
              ? { error: { code: `twilio_${p.ErrorCode ?? "failed"}`, message: `SMS ${p.MessageStatus}`, retryable: !PERMANENT_ERRORS.has(code) } }
              : {}),
          },
        },
      ];
    }
    if (!p.From) return [];
    return [{ kind: "inbound", message: { channel: "sms", from: p.From, externalMessageId: sid, text: p.Body ?? "", receivedAt: this.now() } }];
  }
}
