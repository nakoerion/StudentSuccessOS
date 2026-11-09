import { createECDH, randomBytes } from "node:crypto";

import webpush from "web-push";
import { describe, expect, it } from "vitest";

import type { Channel, OutboundMessage, ProviderRegistry, WebhookRequest } from "../src/adapter";
import { CHANNELS } from "../src/adapter";
import { MemoryOutboxStore, OutboxDispatcher } from "../src/dispatcher";
import type { FetchLike } from "../src/drivers/http";
import { ResendEmailDriver, svixSignature } from "../src/drivers/resend";
import { TelegramDriver } from "../src/drivers/telegram";
import { TwilioSmsDriver, twilioSignature } from "../src/drivers/twilio";
import { WebPushDriver } from "../src/drivers/webpush";
import { WhatsAppCloudDriver, whatsappSignature } from "../src/drivers/whatsapp";
import { FakeDriver, fakeProviders } from "../src/fake";
import { createProviders, describeProviders, PROVIDER_ENV } from "../src/providers";
import { isStopKeyword } from "../src/stop";
import { renderTemplate, TEMPLATE_LOCALES, TEMPLATES, templateParams } from "../src/templates";

const NOW = new Date("2026-11-09T10:00:00Z");
const now = (): Date => NOW;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

/** Scripted fetch: never touches the network, records every call. */
function mockFetch(...responses: { status: number; body: unknown }[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const msg = (channel: Channel, to: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
  idempotencyKey: `ob-${channel}`,
  channel,
  to,
  template: "alert.critical",
  locale: "sq",
  variables: { student: "Arta Hoxha", reason: "attendance fell to 78%" },
  ...extra,
});

const WA = { accessToken: "wa-token", phoneNumberId: "1234", appSecret: "app-secret", verifyToken: "verify-me" };

function waInbound(from: string, text: string, id = "wamid.IN1"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messages: [{ from, id, timestamp: "1762682400", type: "text", text: { body: text } }] } }] }],
  });
}

function signedWa(rawBody: string, secret = WA.appSecret): WebhookRequest {
  return { headers: { "X-Hub-Signature-256": whatsappSignature(rawBody, secret) }, rawBody };
}

const RESEND = { apiKey: "re_key", from: "School <noreply@school.test>", webhookSecret: `whsec_${Buffer.from("resend-secret").toString("base64")}` };
function signedResend(payload: unknown, at = NOW): WebhookRequest {
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(at.getTime() / 1000));
  return { headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": svixSignature(RESEND.webhookSecret, "msg_1", ts, rawBody) }, rawBody };
}

const TWILIO = { accountSid: "AC123", authToken: "tw-token", from: "+15550001111", webhookUrl: "https://example.test/api/webhooks/sms" };
function signedTwilio(params: Record<string, string>): WebhookRequest {
  return { headers: { "x-twilio-signature": twilioSignature(TWILIO.authToken, TWILIO.webhookUrl, params) }, rawBody: new URLSearchParams(params).toString() };
}

const TELEGRAM = { botToken: "123:abc", webhookSecret: "tg-secret" };
function telegramUpdate(chatId: number, text: string): string {
  return JSON.stringify({ update_id: 1, message: { message_id: 7, date: 1762682400, chat: { id: chatId, type: "private" }, text } });
}

describe("webhook signatures", () => {
  const wa = new WhatsAppCloudDriver(WA, { now });

  it("WhatsApp: accepts a valid X-Hub-Signature-256", () => {
    const req = signedWa(waInbound("355691234567", "Faleminderit"));
    expect(wa.verifyWebhook(req)).toBe(true);
    expect(wa.parseWebhook(req)).toEqual([
      {
        kind: "inbound",
        message: { channel: "whatsapp", from: "+355691234567", externalMessageId: "wamid.IN1", text: "Faleminderit", receivedAt: new Date(1762682400 * 1000) },
      },
    ]);
  });

  it("WhatsApp: rejects a missing, malformed or wrong-secret signature", () => {
    const raw = waInbound("355691234567", "hi");
    expect(wa.verifyWebhook({ headers: {}, rawBody: raw })).toBe(false);
    expect(wa.verifyWebhook({ headers: { "x-hub-signature-256": "sha256=deadbeef" }, rawBody: raw })).toBe(false);
    expect(wa.verifyWebhook(signedWa(raw, "someone-elses-secret"))).toBe(false);
  });

  it("WhatsApp: rejects a tampered body", () => {
    const req = signedWa(waInbound("355691234567", "hi"));
    expect(wa.verifyWebhook({ ...req, rawBody: req.rawBody.replace("355691234567", "355690000000") })).toBe(false);
  });

  it("WhatsApp: subscription handshake echoes the challenge only for the right token", () => {
    expect(wa.verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" })).toBe("42");
    expect(wa.verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" })).toBeNull();
  });

  it("Telegram, Resend and Twilio: accepted, rejected and tampered", () => {
    const tg = new TelegramDriver(TELEGRAM, { now });
    const tgReq = { headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" }, rawBody: telegramUpdate(42, "hi") };
    expect(tg.verifyWebhook(tgReq)).toBe(true);
    expect(tg.verifyWebhook({ ...tgReq, headers: { "x-telegram-bot-api-secret-token": "wrong" } })).toBe(false);

    const re = new ResendEmailDriver(RESEND, { now });
    const reReq = signedResend({ type: "email.delivered", created_at: NOW.toISOString(), data: { email_id: "e1" } });
    expect(re.verifyWebhook(reReq)).toBe(true);
    expect(re.verifyWebhook({ ...reReq, rawBody: reReq.rawBody.replace("e1", "e2") })).toBe(false);
    expect(re.verifyWebhook(signedResend({ type: "email.delivered" }, new Date(NOW.getTime() - 3600_000)))).toBe(false); // replay

    const tw = new TwilioSmsDriver(TWILIO, { now });
    const twReq = signedTwilio({ MessageSid: "SM1", From: "+971501234567", Body: "ok" });
    expect(tw.verifyWebhook(twReq)).toBe(true);
    expect(tw.verifyWebhook({ ...twReq, rawBody: twReq.rawBody.replace("ok", "no") })).toBe(false);
    expect(tw.verifyWebhook({ ...twReq, headers: {} })).toBe(false);
  });

  it("the dispatcher refuses to act on an unverified webhook", async () => {
    const store = new MemoryOutboxStore();
    const d = new OutboxDispatcher(store, { whatsapp: wa }, { now });
    const raw = waInbound("355691234567", "STOP");
    expect(await d.handleWebhook("whatsapp", { headers: { "x-hub-signature-256": "sha256=00" }, rawBody: raw })).toMatchObject({ accepted: false, optOuts: [] });
    expect(store.optOuts).toEqual([]);
  });
});

describe("STOP", () => {
  it("recognises whole-message keywords in en, sq and ar only", () => {
    for (const t of ["STOP", " stop! ", "Unsubscribe", "/stop", "/stop@SchoolBot", "NDALO", "Ndalo.", "çregjistrohu", "توقف", "إيقاف", "إلغاء الاشتراك", "أوقف"]) {
      expect(isStopKeyword(t), t).toBe(true);
    }
    for (const t of ["please don't stop", "stopped by the office", "faleminderit", "شكرا", ""]) expect(isStopKeyword(t), t).toBe(false);
  });

  const binding = (externalId: string) => ({ externalId, optInState: "opted_in" as const, meta: {} });

  it("opts the sender out on every channel and cancels what was queued for them", async () => {
    const pushKeys = { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    const vapid = webpush.generateVAPIDKeys();
    const providers: ProviderRegistry = {
      whatsapp: new WhatsAppCloudDriver(WA, { now }),
      telegram: new TelegramDriver(TELEGRAM, { now }),
      email: new ResendEmailDriver(RESEND, { now }),
      sms: new TwilioSmsDriver(TWILIO, { now }),
      push: new WebPushDriver(
        { vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, vapidSubject: "mailto:ops@school.test" },
        { now, fetch: mockFetch({ status: 410, body: "subscription expired" }) },
      ),
    };
    const addr: Record<Channel, string> = {
      whatsapp: "+355691234567",
      telegram: "42",
      email: "parent@example.test",
      sms: "+971501234567",
      push: "https://push.example.test/sub/abc",
    };
    const store = new MemoryOutboxStore();
    for (const c of CHANNELS) {
      store.add({ id: `later-${c}`, channel: c, template: "digest.weekly", locale: "en", payload: { student: "A", summary: "s" }, idempotencyKey: null, recipient: binding(addr[c]) });
    }
    store.get("later-push").recipient = { ...binding(addr.push), meta: { keys: pushKeys } };
    const d = new OutboxDispatcher(store, providers, { now });

    const wa = await d.handleWebhook("whatsapp", signedWa(waInbound("355691234567", "NDALO")));
    const tg = await d.handleWebhook("telegram", { headers: { "x-telegram-bot-api-secret-token": "tg-secret" }, rawBody: telegramUpdate(42, "/stop") });
    const em = await d.handleWebhook("email", signedResend({ type: "email.received", created_at: NOW.toISOString(), data: { email_id: "in1", from: "Parent <Parent@example.test>", subject: "إلغاء الاشتراك" } }));
    const sms = await d.handleWebhook("sms", signedTwilio({ MessageSid: "SM9", From: "+971501234567", Body: "توقف" }));
    for (const o of [wa, tg, em, sms]) expect(o).toMatchObject({ accepted: true, inbound: [] });
    expect([wa, tg, em, sms].map((o) => o.optOuts[0]?.externalId)).toEqual([addr.whatsapp, addr.telegram, addr.email, addr.sms]);

    // Push has no replies: an expired subscription (410) is its STOP.
    expect(await d.dispatchOne((await store.due(NOW, 10)).find((r) => r.channel === "push")!)).toBe("dead");

    expect(store.optOuts.map((o) => o.channel).sort()).toEqual([...CHANNELS].sort());
    const summary = await d.dispatchDue();
    expect(summary).toEqual({ sent: 0, failed: 0, dead: 0, cancelled: 4, skipped: 0 });
    for (const c of ["whatsapp", "telegram", "email", "sms"] as const) expect(store.get(`later-${c}`)).toMatchObject({ state: "cancelled", lastError: "recipient_opted_out" });
  });

  it("works the same through the fake driver on every channel, and ordinary replies are routed", async () => {
    const store = new MemoryOutboxStore();
    const fakes = fakeProviders({ webhookSecret: "t" });
    const d = new OutboxDispatcher(store, fakes, { now });
    for (const c of CHANNELS) {
      const out = await d.handleWebhook(
        c,
        fakes[c].webhook([
          { kind: "inbound", message: { channel: c, from: `u-${c}`, externalMessageId: "1", text: "Stop", receivedAt: NOW } },
          { kind: "inbound", message: { channel: c, from: `u-${c}`, externalMessageId: "2", text: "Faleminderit!", receivedAt: NOW } },
        ]),
      );
      expect(out.optOuts.map((o) => o.externalId)).toEqual([`u-${c}`]);
      expect(out.inbound.map((m) => m.text)).toEqual(["Faleminderit!"]);
    }
  });

  it("provider-side opt-outs: blocked Telegram bot, e-mail complaint, Twilio 21610", async () => {
    const tg = new TelegramDriver(TELEGRAM, { now });
    expect(tg.parseWebhook({ headers: {}, rawBody: JSON.stringify({ my_chat_member: { chat: { id: 42 }, new_chat_member: { status: "kicked" } } }) })[0]).toMatchObject({
      kind: "opt_out",
      optOut: { channel: "telegram", externalId: "42" },
    });
    const re = new ResendEmailDriver(RESEND, { now });
    expect(re.parseWebhook(signedResend({ type: "email.complained", data: { email_id: "e1", to: ["P@x.test"] } }))[0]).toMatchObject({ kind: "opt_out", optOut: { externalId: "p@x.test" } });
    const tw = new TwilioSmsDriver(TWILIO, { now, fetch: mockFetch({ status: 400, body: { code: 21610, message: "unsubscribed recipient" } }) });
    expect(await tw.send(msg("sms", "+971501234567"))).toMatchObject({ ok: false, error: { code: "twilio_21610", retryable: false, optOut: true } });
  });
});

describe("templates in sq / en / ar", () => {
  const vars = { student: "Arta Hoxha", reason: "attendance 78%", summary: "3 grades, 1 absence", sender: "Ms. Kola", preview: "See you", goal: "Math 8+", progress: 60, title: "Exams" };

  it("renders every template in all three languages with no unfilled placeholders", () => {
    for (const key of Object.keys(TEMPLATES)) {
      for (const loc of TEMPLATE_LOCALES) {
        const t = renderTemplate(key, loc, vars);
        expect(t.subject + t.body).not.toMatch(/\{\{|\}\}/);
        expect(t.dir).toBe(loc === "ar" ? "rtl" : "ltr");
      }
    }
  });

  it("produces the expected text per language", () => {
    expect(renderTemplate("alert.critical", "sq", vars).subject).toBe("Kërkohet vëmendje: Arta Hoxha");
    expect(renderTemplate("alert.critical", "en", vars).body).toBe("Arta Hoxha needs attention: attendance 78%. Open Student Success OS for the full explanation.");
    expect(renderTemplate("alert.critical", "ar-AE", vars)).toMatchObject({ locale: "ar", dir: "rtl", subject: "مطلوب انتباه: Arta Hoxha" });
    expect(renderTemplate("goal.nudge", "fr", vars).locale).toBe("en");
  });

  it("refuses unknown templates and missing variables (a permanent send error)", async () => {
    expect(() => renderTemplate("nope", "en", {})).toThrow(/unknown template/);
    expect(() => renderTemplate("alert.critical", "ar", { student: "A" })).toThrow(/missing variable "reason"/);
    const f = mockFetch();
    const tg = new TelegramDriver(TELEGRAM, { fetch: f, now });
    expect(await tg.send(msg("telegram", "42", { variables: { student: "A" } }))).toMatchObject({ ok: false, error: { code: "template_error", retryable: false } });
    expect(f.calls).toHaveLength(0);
  });

  it("each driver sends the rendered locale", async () => {
    const waFetch = mockFetch({ status: 200, body: { messages: [{ id: "wamid.OUT1" }] } });
    const wa = new WhatsAppCloudDriver(WA, { fetch: waFetch, now });
    expect(await wa.send(msg("whatsapp", "+355691234567", { locale: "ar" }))).toEqual({ ok: true, providerMessageId: "wamid.OUT1", acceptedAt: NOW });
    const body = JSON.parse(waFetch.calls[0]!.body as string);
    expect(waFetch.calls[0]!.url).toBe("https://graph.facebook.com/v21.0/1234/messages");
    expect(waFetch.calls[0]!.headers.authorization).toBe("Bearer wa-token");
    expect(body).toMatchObject({ to: "355691234567", template: { name: "ssos_alert_critical", language: { code: "ar" } } });
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(templateParams("alert.critical", msg("whatsapp", "x").variables));

    const reFetch = mockFetch({ status: 200, body: { id: "re-1" } });
    await new ResendEmailDriver(RESEND, { fetch: reFetch, now }).send(msg("email", "p@x.test", { locale: "ar" }));
    const email = JSON.parse(reFetch.calls[0]!.body as string);
    expect(email.subject).toBe("مطلوب انتباه: Arta Hoxha");
    expect(email.html).toContain('dir="rtl"');
    expect(reFetch.calls[0]!.headers["idempotency-key"]).toBe("ob-email");

    const twFetch = mockFetch({ status: 201, body: { sid: "SM1" } });
    await new TwilioSmsDriver(TWILIO, { fetch: twFetch, now }).send(msg("sms", "+355691234567"));
    expect(new URLSearchParams(twFetch.calls[0]!.body as string).get("Body")).toMatch(/^Arta Hoxha ka nevojë për vëmendje.*NDALO/);

    const tgFetch = mockFetch({ status: 200, body: { ok: true, result: { message_id: 9 } } });
    expect(await new TelegramDriver(TELEGRAM, { fetch: tgFetch, now }).send(msg("telegram", "42", { locale: "en" }))).toMatchObject({ ok: true, providerMessageId: "42:9" });
    expect(JSON.parse(tgFetch.calls[0]!.body as string).text).toMatch(/^Attention needed: Arta Hoxha/);

    const vapid = webpush.generateVAPIDKeys();
    const pushFetch = mockFetch({ status: 201, body: "" });
    const keys = { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    const push = new WebPushDriver({ vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, vapidSubject: "mailto:ops@school.test" }, { fetch: pushFetch, now });
    expect(await push.send(msg("push", "https://push.example.test/sub/1", { meta: { keys } }))).toMatchObject({ ok: true });
    expect(pushFetch.calls[0]!.headers).toMatchObject({ "Content-Encoding": "aes128gcm" });
    expect(pushFetch.calls[0]!.headers.Authorization).toMatch(/^vapid t=/);
  });
});

describe("env and fallback", () => {
  it("every channel runs on the fake driver when its secrets are absent", () => {
    const p = createProviders({});
    for (const c of CHANNELS) expect(p[c]).toBeInstanceOf(FakeDriver);
    // Partial credentials are not enough.
    expect(createProviders({ WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_PHONE_NUMBER_ID: "1" }).whatsapp).toBeInstanceOf(FakeDriver);
  });

  it("real drivers activate from env", () => {
    const vapid = webpush.generateVAPIDKeys();
    const env: Record<string, string> = {
      WHATSAPP_ACCESS_TOKEN: "t",
      WHATSAPP_PHONE_NUMBER_ID: "1",
      WHATSAPP_APP_SECRET: "s",
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      RESEND_API_KEY: "k",
      RESEND_FROM: "a@b.test",
      RESEND_WEBHOOK_SECRET: "whsec_c2VjcmV0",
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_FROM: "+1555",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:a@b.test",
    };
    expect(Object.values(PROVIDER_ENV).flatMap((v) => v.required).sort()).toEqual(Object.keys(env).sort());
    expect(describeProviders(createProviders(env))).toEqual({ whatsapp: "whatsapp-cloud", telegram: "telegram-bot", email: "resend", sms: "twilio-sms", push: "web-push" });
  });
});

describe("outbox dispatcher", () => {
  const row = (id: string, channel: Channel = "whatsapp") => ({
    id,
    channel,
    template: "alert.critical",
    locale: "en",
    payload: { student: "A", reason: "r" },
    idempotencyKey: `idem-${id}`,
    recipient: { externalId: "+355690000001", optInState: "opted_in" as const, meta: {} },
  });

  it("routes by channel, retries with backoff from the attempt count, then dies", async () => {
    let clock = NOW;
    const fakes = fakeProviders();
    fakes.whatsapp.failNext(3);
    const store = new MemoryOutboxStore().add({ ...row("a"), maxAttempts: 3 }).add(row("b", "email"));
    const d = new OutboxDispatcher(store, fakes, { now: () => clock });

    expect(await d.dispatchDue()).toEqual({ sent: 1, failed: 1, dead: 0, cancelled: 0, skipped: 0 });
    expect(fakes.email.delivered.map((m) => m.idempotencyKey)).toEqual(["idem-b"]);
    expect(store.get("b")).toMatchObject({ state: "sent", attempts: 1, providerMessageId: "fake-email-1" });
    expect(store.get("a")).toMatchObject({ state: "failed", attempts: 1, nextAttemptAt: new Date(NOW.getTime() + 60_000) });

    expect(await d.dispatchDue()).toMatchObject({ sent: 0, failed: 0 }); // not due yet
    clock = new Date(NOW.getTime() + 60_000);
    await d.dispatchDue();
    expect(store.get("a")).toMatchObject({ state: "failed", attempts: 2, nextAttemptAt: new Date(clock.getTime() + 120_000) });
    clock = new Date(clock.getTime() + 120_000);
    expect(await d.dispatchDue()).toMatchObject({ dead: 1 });
    expect(store.get("a")).toMatchObject({ state: "dead", attempts: 3, lastError: "fake_unavailable: simulated provider failure" });
  });

  it("records delivery receipts and never sends a row twice", async () => {
    const fakes = fakeProviders({ webhookSecret: "t" });
    const store = new MemoryOutboxStore().add(row("a")).add(row("b"));
    const d = new OutboxDispatcher(store, fakes, { now });
    const [a] = await store.due(NOW, 1);
    await d.dispatchDue();
    expect(await d.dispatchOne(a!)).toBe("skipped"); // stale snapshot: compare-and-set refuses
    expect(fakes.whatsapp.sent).toHaveLength(2);

    const out = await d.handleWebhook(
      "whatsapp",
      fakes.whatsapp.webhook([
        { kind: "receipt", receipt: { channel: "whatsapp", providerMessageId: store.get("a").providerMessageId!, status: "read", at: NOW } },
        {
          kind: "receipt",
          receipt: { channel: "whatsapp", providerMessageId: store.get("b").providerMessageId!, status: "failed", at: NOW, error: { code: "x", message: "y", retryable: false } },
        },
      ]),
    );
    expect(out.receiptsApplied).toBe(2);
    expect(store.get("a")).toMatchObject({ state: "delivered", deliveredAt: NOW });
    expect(store.get("b")).toMatchObject({ state: "dead", lastError: "x: y" });
  });

  it("parses real WhatsApp status callbacks into receipts", () => {
    const wa = new WhatsAppCloudDriver(WA, { now });
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1762682400" }, { id: "wamid.OUT1", status: "sent" }] } }] }] });
    expect(wa.parseWebhook(signedWa(raw))).toEqual([{ kind: "receipt", receipt: { channel: "whatsapp", providerMessageId: "wamid.OUT1", status: "delivered", at: new Date(1762682400 * 1000) } }]);
  });

  it("maps provider HTTP errors to retryable or permanent", async () => {
    const wa = new WhatsAppCloudDriver(WA, { now, fetch: mockFetch({ status: 503, body: {} }, { status: 400, body: { error: { code: 132001, message: "template does not exist" } } }) });
    expect(await wa.send(msg("whatsapp", "+1"))).toMatchObject({ ok: false, error: { retryable: true } });
    expect(await wa.send(msg("whatsapp", "+1"))).toMatchObject({ ok: false, error: { code: "whatsapp_132001", retryable: false } });
  });
});
