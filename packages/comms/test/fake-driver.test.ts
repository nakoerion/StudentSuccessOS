import { describe, expect, it } from "vitest";

import type { OutboundMessage } from "../src/adapter";
import { CHANNELS } from "../src/adapter";
import { FakeDriver, fakeProviders } from "../src/fake";
import { canTransition, outcomeOfSend } from "../src/outbox-state";

const msg = (to: string): OutboundMessage => ({
  idempotencyKey: `k-${to}`,
  channel: "whatsapp",
  to,
  template: "alert.critical",
  locale: "sq",
  variables: { student: "A" },
});

describe("FakeDriver", () => {
  it("records what it sent and returns provider ids", async () => {
    const d = new FakeDriver("whatsapp");
    const r = await d.send(msg("+355690000001"));
    expect(r).toMatchObject({ ok: true, providerMessageId: "fake-whatsapp-1" });
    expect(d.delivered.map((m) => m.to)).toEqual(["+355690000001"]);
  });

  it("simulates queued and conditional failures, and records them too", async () => {
    const d = new FakeDriver("sms").failNext(2).failWhen((m) =>
      m.to.endsWith("9") ? { code: "invalid_number", retryable: false } : null,
    );
    const results = [await d.send(msg("1")), await d.send(msg("2")), await d.send(msg("3")), await d.send(msg("9"))];
    expect(results.map((r) => (r.ok ? "ok" : `${r.error.code}/${r.error.retryable}`))).toEqual([
      "fake_unavailable/true",
      "fake_unavailable/true",
      "ok",
      "invalid_number/false",
    ]);
    expect(d.sent).toHaveLength(4);
    expect(d.delivered).toHaveLength(1);
    d.reset();
    expect((await d.send(msg("9"))).ok).toBe(true);
  });

  it("signs webhooks and rejects tampered ones", () => {
    const d = new FakeDriver("telegram", { webhookSecret: "s3cret" });
    const req = d.webhook([
      {
        kind: "inbound",
        message: { channel: "telegram", from: "42", externalMessageId: "m1", text: "STOP", receivedAt: new Date("2026-11-09T10:00:00Z") },
      },
    ]);
    expect(d.verifyWebhook(req)).toBe(true);
    expect(d.parseWebhook(req)).toEqual([
      {
        kind: "inbound",
        message: { channel: "telegram", from: "42", externalMessageId: "m1", text: "STOP", receivedAt: new Date("2026-11-09T10:00:00Z") },
      },
    ]);
    expect(d.verifyWebhook({ ...req, rawBody: req.rawBody.replace("STOP", "HI") })).toBe(false);
    expect(new FakeDriver("telegram", { webhookSecret: "other" }).verifyWebhook(req)).toBe(false);
    expect(d.verifyWebhook({ headers: {}, rawBody: req.rawBody })).toBe(false);
  });

  it("fakeProviders covers every channel", () => {
    const p = fakeProviders();
    expect(CHANNELS.map((c) => p[c].channel)).toEqual([...CHANNELS]);
  });
});

describe("outbox outcome", () => {
  const now = new Date("2026-11-09T10:00:00Z");
  it("maps send results onto legal next states", () => {
    expect(outcomeOfSend({ ok: true, providerMessageId: "p", acceptedAt: now }, 1, 5, now).state).toBe("sent");
    const retry = outcomeOfSend({ ok: false, error: { code: "x", message: "y", retryable: true } }, 1, 5, now);
    expect(retry).toEqual({ state: "failed", lastError: "x: y", nextAttemptAt: new Date("2026-11-09T10:01:00Z") });
    expect(outcomeOfSend({ ok: false, error: { code: "x", message: "y", retryable: true } }, 5, 5, now).state).toBe("dead");
    expect(outcomeOfSend({ ok: false, error: { code: "x", message: "y", retryable: false } }, 1, 5, now).state).toBe("dead");
    for (const s of ["sent", "failed", "dead"] as const) expect(canTransition("sending", s)).toBe(true);
    expect(canTransition("delivered", "failed")).toBe(false);
  });
});
