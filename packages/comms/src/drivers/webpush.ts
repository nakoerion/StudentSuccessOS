import webpush from "web-push";

import type { OutboundMessage, ProviderAdapter, SendResult } from "../adapter";
import { renderTemplate } from "../templates";
import { defaultFetch, type DriverOptions, type FetchLike, guardSend, httpError } from "./http";

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** "mailto:..." or an https URL identifying the sender to push services. */
  vapidSubject: string;
  /** Seconds a push service keeps an undelivered message. */
  ttlSeconds?: number;
}

/**
 * Web Push with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291). The
 * subscription endpoint is channel_binding.external_id; its p256dh/auth keys live in
 * channel_binding.meta. Push has no inbound traffic, so no webhook methods.
 */
export class WebPushDriver implements ProviderAdapter {
  readonly name = "web-push";
  readonly channel = "push" as const;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: WebPushConfig,
    options: DriverOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? (() => new Date());
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return guardSend(async () => {
      const keys = (message.meta?.keys ?? message.meta) as { p256dh?: unknown; auth?: unknown } | undefined;
      if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") {
        return { ok: false, error: { code: "push_missing_keys", message: "subscription has no p256dh/auth keys", retryable: false } };
      }
      const t = renderTemplate(message.template, message.locale, message.variables);
      const payload = JSON.stringify({ title: t.subject, body: t.body, dir: t.dir, lang: t.locale, tag: message.idempotencyKey });
      const req = webpush.generateRequestDetails({ endpoint: message.to, keys: { p256dh: keys.p256dh, auth: keys.auth } }, payload, {
        vapidDetails: { subject: this.config.vapidSubject, publicKey: this.config.vapidPublicKey, privateKey: this.config.vapidPrivateKey },
        TTL: this.config.ttlSeconds ?? 24 * 3600,
        contentEncoding: "aes128gcm",
      });
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const res = await this.fetch(req.endpoint, { method: req.method, headers, ...(req.body ? { body: new Uint8Array(req.body) } : {}) });
      if (!res.ok) {
        // 404/410: the subscription expired or the user revoked permission.
        const gone = res.status === 404 || res.status === 410;
        const result = httpError(res.status, gone ? "push_subscription_gone" : `push_${res.status}`, (await res.text()) || `HTTP ${res.status}`, gone);
        return result;
      }
      return { ok: true, providerMessageId: `push:${message.idempotencyKey}`, acceptedAt: this.now() };
    });
  }
}
