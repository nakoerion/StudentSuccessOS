/**
 * AI usage and quality page: the client's usage()/latestEvals(), and the page's rules —
 * above all that a run on the fake provider never renders as a quality pass, that spend keeps
 * four decimals, and that a floored cap with no seat count says so.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import sq from "../messages/sq.json";
import { canViewAiUsage } from "../lib/access";
import { AiServiceError, createAiClient, type EvalRun, type UsageReport } from "../lib/ai/client";
import { barGeometry, CAP_FORMAT, capLine, essentialLine, evalQuality, poolState, SPEND_FORMAT } from "../lib/ai/usage";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "test-service-token-0123456789abcdef";

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply> = {};
let lastUrl: URL | null = null;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const r = replies[lastUrl.pathname] ?? { status: 404, body: { error: "not_found" } };
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = (tenantId = TENANT) => createAiClient(tenantId, { baseUrl, token: TOKEN, timeoutMs: 2_000 });

const pool = (capUsd: number, spentUsd: number, hardStop: boolean) => ({
  capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd), usedRatio: spentUsd / capUsd, warningRatio: 0.8,
  warning: spentUsd / capUsd >= 0.8, exhausted: spentUsd >= capUsd, hardStop, calls: 3, fakeCalls: 3,
});

const report = (tenantId = TENANT): UsageReport => ({
  tenantId,
  monthStart: "2026-11-01T00:00:00.000Z",
  currency: "USD",
  pools: { discretionary: pool(50, 0.0042, true), essential: pool(10, 0.0003, false) },
  derivation: {
    discretionary: { basis: "floor", capUsd: 50, seatCount: null, perSeatUsd: 0.1, floorUsd: 50 },
    essential: { basis: "floor", capUsd: 10, floorUsd: 10 },
  },
  nominal: true,
});

const run = (over: Partial<EvalRun>): EvalRun => ({
  id: "r1", suiteId: "golden.al.math", suiteKind: "golden", pack: "AL", subject: "math", providerMode: "fake", models: ["fake"],
  cases: 12, passed: 12, plumbingScore: 1, qualityScore: null, qualityMeasured: 0, verdict: "pass", costUsd: 0,
  startedAt: "2026-11-17T10:00:00.000Z", finishedAt: "2026-11-17T10:00:05.000Z", ...over,
});

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof AiServiceError ? err.kind : "other";
  }
}

describe("client.usage()", () => {
  it("asks for the bound tenant only and returns the report", async () => {
    replies = { "/v1/admin/usage": { status: 200, body: report() } };
    const out = await client().usage();
    expect(lastUrl?.searchParams.getAll("tenantId")).toEqual([TENANT]);
    expect(out.pools.discretionary.spentUsd).toBe(0.0042);
  });

  it("rejects a report for another tenant", async () => {
    replies = { "/v1/admin/usage": { status: 200, body: report(OTHER_TENANT) } };
    expect(await kindOf(client().usage())).toBe("unreachable");
  });

  it("maps a 503 to unreachable and a missing config to not_configured", async () => {
    replies = { "/v1/admin/usage": { status: 503, body: { error: "usage_not_configured" } } };
    expect(await kindOf(client().usage())).toBe("unreachable");
    expect(await kindOf(createAiClient(TENANT, null).usage())).toBe("not_configured");
  });

  it("latestEvals() returns the runs", async () => {
    replies = { "/v1/admin/evals": { status: 200, body: { runs: [run({})] } } };
    expect((await client().latestEvals()).map((r) => r.suiteId)).toEqual(["golden.al.math"]);
  });
});

describe("evalQuality: a fake run is never a quality pass", () => {
  it("fake provider → not measured, even with verdict pass and every case passed", () => {
    expect(evalQuality(run({ providerMode: "fake", verdict: "pass", passed: 12 }))).toEqual({ kind: "not_measured" });
  });

  it("fake provider → not measured even if a quality score were present", () => {
    expect(evalQuality(run({ providerMode: "fake", qualityScore: 1 }))).toEqual({ kind: "not_measured" });
  });

  it("no calls, or a live run without a score → not measured", () => {
    expect(evalQuality(run({ providerMode: "none" }))).toEqual({ kind: "not_measured" });
    expect(evalQuality(run({ providerMode: "live", qualityScore: null }))).toEqual({ kind: "not_measured" });
  });

  it("mixed → partial, never the green measured state", () => {
    expect(evalQuality(run({ providerMode: "mixed", qualityScore: 0.9, qualityMeasured: 4 }))).toEqual({ kind: "partial", score: 0.9, measured: 4 });
  });

  it("live with a score → measured; good on pass, bad on regression", () => {
    expect(evalQuality(run({ providerMode: "live", qualityScore: 0.92, verdict: "pass" }))).toEqual({ kind: "measured", score: 0.92, tone: "good" });
    expect(evalQuality(run({ providerMode: "live", qualityScore: 0.7, verdict: "regression" }))).toMatchObject({ tone: "bad" });
  });
});

describe("money formatting", () => {
  it("spend keeps four decimals so a real figure is never $0.00", () => {
    expect(new Intl.NumberFormat("en", SPEND_FORMAT).format(0.0042)).toBe("$0.0042");
    expect(new Intl.NumberFormat("en", SPEND_FORMAT).format(0.00004)).toBe("$0.0000");
    expect(new Intl.NumberFormat("en", SPEND_FORMAT).format(12.3456)).toBe("$12.3456");
  });
  it("caps are ordinary currency", () => {
    expect(new Intl.NumberFormat("en", CAP_FORMAT).format(50)).toBe("$50.00");
  });
});

describe("cap derivation line", () => {
  it("no seat count → the floor line, never a per-seat figure", () => {
    expect(capLine(report().derivation.discretionary)).toEqual({ key: "derivation.floorNoSeats", values: { floor: 50 } });
  });
  it("seats below the floor, seats above it, and explicit caps", () => {
    expect(capLine({ basis: "floor", capUsd: 50, seatCount: 130, perSeatUsd: 0.1, floorUsd: 50 })).toEqual({
      key: "derivation.floorBelow", values: { seats: 130, perSeat: 0.1, computed: 13, floor: 50 },
    });
    expect(capLine({ basis: "per_seat", capUsd: 120, seatCount: 1200, perSeatUsd: 0.1, floorUsd: 50 })).toEqual({
      key: "derivation.perSeat", values: { seats: 1200, perSeat: 0.1, floor: 50, cap: 120 },
    });
    expect(capLine({ basis: "explicit", capUsd: 200, seatCount: null }).key).toBe("derivation.explicit");
    expect(essentialLine({ basis: "share", capUsd: 24, share: 0.2 }).key).toBe("derivation.essentialShare");
  });
});

describe("bars and states", () => {
  it("clamps the fill and marks the 80% line", () => {
    expect(barGeometry({ usedRatio: 0.5, warningRatio: 0.8 })).toEqual({ fill: 50, warningAt: 80 });
    expect(barGeometry({ usedRatio: 1.3, warningRatio: 0.8 }).fill).toBe(100);
  });
  it("ok → warning → exhausted", () => {
    expect(poolState({ warning: false, exhausted: false })).toBe("ok");
    expect(poolState({ warning: true, exhausted: false })).toBe("warning");
    expect(poolState({ warning: true, exhausted: true })).toBe("exhausted");
  });
});

describe("access", () => {
  it("needs ai_usage.read", () => {
    expect(canViewAiUsage({ personId: "p", roles: ["admin"], permissions: new Set(["ai_usage.read"]) })).toBe(true);
    expect(canViewAiUsage({ personId: "p", roles: ["advisor"], permissions: new Set(["roster.read", "mastery.read"]) })).toBe(false);
  });
});

describe("messages", () => {
  const keys = (o: unknown, prefix = ""): string[] =>
    o && typeof o === "object"
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  it("sq/en/ar carry the same aiUsage keys", () => {
    const want = keys(en.aiUsage).sort();
    expect(keys(sq.aiUsage).sort()).toEqual(want);
    expect(keys(ar.aiUsage).sort()).toEqual(want);
    for (const m of [en, sq, ar]) expect(typeof m.nav.aiUsage).toBe("string");
  });
  it("the not-measured label is what the harness reports", () => {
    expect(en.aiUsage.evals.notMeasured).toBe("Not measured (no live model)");
  });
});
