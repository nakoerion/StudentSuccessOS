import { type Channel, type ProviderAdapter } from "./adapter";
import type { DriverOptions } from "./drivers/http";
import { ResendEmailDriver } from "./drivers/resend";
import { TelegramDriver } from "./drivers/telegram";
import { TwilioSmsDriver } from "./drivers/twilio";
import { WebPushDriver } from "./drivers/webpush";
import { WhatsAppCloudDriver } from "./drivers/whatsapp";
import { FakeDriver } from "./fake";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Env variables each real driver needs. Secrets come from the environment only; when
 * any required one is absent the channel runs on the FakeDriver, so tests and local runs
 * never call a provider.
 */
export const PROVIDER_ENV: Readonly<Record<Channel, { required: readonly string[]; optional: readonly string[] }>> = {
  whatsapp: {
    required: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"],
    optional: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_API_VERSION", "WHATSAPP_TEMPLATE_PREFIX"],
  },
  telegram: { required: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"], optional: [] },
  email: { required: ["RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET"], optional: [] },
  sms: { required: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"], optional: ["TWILIO_WEBHOOK_URL"] },
  push: { required: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"], optional: ["WEB_PUSH_TTL_SECONDS"] },
};

export type Providers = Record<Channel, ProviderAdapter>;

function present(env: Env, names: readonly string[]): boolean {
  return names.every((n) => (env[n] ?? "").trim() !== "");
}

function opt(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** One adapter per channel: the real driver when its secrets are set, otherwise the fake. */
export function createProviders(env: Env = process.env, options: DriverOptions & { fakeWebhookSecret?: string } = {}): Providers {
  const e = (n: string): string => (env[n] ?? "").trim();
  const fake = (c: Channel): FakeDriver =>
    new FakeDriver(c, { ...(options.fakeWebhookSecret ? { webhookSecret: options.fakeWebhookSecret } : {}), ...(options.now ? { now: options.now } : {}) });
  const has = (c: Channel): boolean => present(env, PROVIDER_ENV[c].required);
  const ttl = Number(opt(env, "WEB_PUSH_TTL_SECONDS"));
  const verifyToken = opt(env, "WHATSAPP_VERIFY_TOKEN");
  const businessAccountId = opt(env, "WHATSAPP_BUSINESS_ACCOUNT_ID");
  const apiVersion = opt(env, "WHATSAPP_API_VERSION");
  const templatePrefix = opt(env, "WHATSAPP_TEMPLATE_PREFIX");
  const webhookUrl = opt(env, "TWILIO_WEBHOOK_URL");

  return {
    whatsapp: has("whatsapp")
      ? new WhatsAppCloudDriver(
          {
            accessToken: e("WHATSAPP_ACCESS_TOKEN"),
            phoneNumberId: e("WHATSAPP_PHONE_NUMBER_ID"),
            appSecret: e("WHATSAPP_APP_SECRET"),
            ...(verifyToken ? { verifyToken } : {}),
            ...(businessAccountId ? { businessAccountId } : {}),
            ...(apiVersion ? { apiVersion } : {}),
            ...(templatePrefix ? { templatePrefix } : {}),
          },
          options,
        )
      : fake("whatsapp"),
    telegram: has("telegram")
      ? new TelegramDriver({ botToken: e("TELEGRAM_BOT_TOKEN"), webhookSecret: e("TELEGRAM_WEBHOOK_SECRET") }, options)
      : fake("telegram"),
    email: has("email")
      ? new ResendEmailDriver({ apiKey: e("RESEND_API_KEY"), from: e("RESEND_FROM"), webhookSecret: e("RESEND_WEBHOOK_SECRET") }, options)
      : fake("email"),
    sms: has("sms")
      ? new TwilioSmsDriver(
          { accountSid: e("TWILIO_ACCOUNT_SID"), authToken: e("TWILIO_AUTH_TOKEN"), from: e("TWILIO_FROM"), ...(webhookUrl ? { webhookUrl } : {}) },
          options,
        )
      : fake("sms"),
    push: has("push")
      ? new WebPushDriver(
          {
            vapidPublicKey: e("VAPID_PUBLIC_KEY"),
            vapidPrivateKey: e("VAPID_PRIVATE_KEY"),
            vapidSubject: e("VAPID_SUBJECT"),
            ...(Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: ttl } : {}),
          },
          options,
        )
      : fake("push"),
  };
}

/** Which channels are live vs. faked — for health checks and logs; never prints secrets. */
export function describeProviders(providers: Providers): Record<Channel, string> {
  return Object.fromEntries(Object.entries(providers).map(([c, p]) => [c, p.name])) as Record<Channel, string>;
}
