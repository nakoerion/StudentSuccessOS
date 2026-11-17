/**
 * Advisor mastery heatmap: the client's `mastery()` (tenant binding, query shape, error
 * mapping) and the aggregate maths — above all, that "no attempts" is never counted as zero.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import sq from "../messages/sq.json";
import { AiServiceError, createAiClient, MASTERY_MAX_STUDENTS, type MasteryResult } from "../lib/ai/client";
import { buildGrid, gridIsEmpty, masteryLevel, summarizeConcepts } from "../lib/ai/mastery";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";
const TOKEN = "test-service-token-0123456789abcdef";

type Reply = { status: number; body: unknown };
let reply: Reply = { status: 200, body: {} };
let lastRequest: { method: string; url: URL; auth: string | undefined } | null = null;
let requests = 0;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    lastRequest = { method: req.method ?? "", url: new URL(req.url ?? "/", "http://x"), auth: req.headers.authorization };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = (tenantId = TENANT, token = TOKEN) => createAiClient(tenantId, { baseUrl, token, timeoutMs: 2_000 });
const cell = (conceptCode: string, pMastery: number, attempts = 3) => ({ conceptCode, pMastery, attempts, correct: Math.round(attempts * pMastery), lastSeen: "2026-11-14T12:00:00.000Z" });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof AiServiceError ? err.kind : `other:${String(err)}`;
  }
}

describe("AiClient.mastery", () => {
  const body: MasteryResult = { tenantId: TENANT, concepts: ["X.1"], students: [{ studentId: A, mastery: [cell("X.1", 0.5)] }, { studentId: B, mastery: [] }] };

  it("GETs /v1/mastery with repeated studentId, the prefix, and the bound tenant", async () => {
    reply = { status: 200, body };
    const r = await client().mastery({ studentIds: [A, B, A], conceptPrefix: "MAT.10" });
    expect(r).toEqual(body);
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url.pathname).toBe("/v1/mastery");
    expect(lastRequest?.url.searchParams.getAll("studentId")).toEqual([A, B]);
    expect(lastRequest?.url.searchParams.get("conceptPrefix")).toBe("MAT.10");
    expect(lastRequest?.url.searchParams.getAll("tenantId")).toEqual([TENANT]);
    expect(lastRequest?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("does not call the service for an empty class and refuses more than the service allows", async () => {
    const before = requests;
    expect(await client().mastery({ studentIds: [] })).toEqual({ tenantId: TENANT, concepts: [], students: [] });
    const many = Array.from({ length: MASTERY_MAX_STUDENTS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await kindOf(client().mastery({ studentIds: many }))).toBe("invalid_request");
    expect(requests).toBe(before);
  });

  it("maps errors like the tutor, and rejects another tenant's or a malformed answer", async () => {
    const cases: [Reply, string][] = [
      [{ status: 503, body: { error: "agent_not_configured" } }, "unreachable"],
      [{ status: 400, body: { error: "invalid_request" } }, "invalid_request"],
      [{ status: 500, body: { error: "internal_error" } }, "unreachable"],
      [{ status: 200, body: { ...body, tenantId: OTHER_TENANT } }, "unreachable"],
      [{ status: 200, body: { tenantId: TENANT, concepts: [], students: [{ studentId: A, mastery: [{ conceptCode: "X" }] }] } }, "unreachable"],
    ];
    for (const [r, kind] of cases) {
      reply = r;
      expect(await kindOf(client().mastery({ studentIds: [A] }))).toBe(kind);
    }
    expect(await kindOf(client(TENANT, "wrong").mastery({ studentIds: [A] }))).toBe("unauthorized");
    expect(await kindOf(createAiClient(TENANT, null).mastery({ studentIds: [A] }))).toBe("not_configured");
  });
});

describe("mastery maths", () => {
  const result: MasteryResult = {
    tenantId: TENANT,
    concepts: ["K.1", "K.2", "K.3"],
    students: [
      { studentId: A, mastery: [cell("K.1", 0.9), cell("K.2", 0.2)] },
      // B never attempted K.1 and has a zero-attempt row for K.2: both are "no data".
      { studentId: B, mastery: [cell("K.2", 0.4), cell("K.1", 0.1, 0)] },
      { studentId: C, mastery: [] },
    ],
  };

  it("builds the grid in roster order with null for no attempts", () => {
    const grid = buildGrid(result, [C, A, B]);
    expect(grid.rows.map((r) => r.studentId)).toEqual([C, A, B]);
    expect(grid.rows[0]!.cells).toEqual({ "K.1": null, "K.2": null, "K.3": null });
    expect(grid.rows[2]!.cells["K.1"]).toBeNull();
    expect(grid.rows[1]!.cells["K.1"]).toMatchObject({ pMastery: 0.9, attempts: 3 });
  });

  it("averages only assessed students, ranks weakest first, and omits concepts nobody attempted", () => {
    const summary = summarizeConcepts(buildGrid(result, [A, B, C]));
    expect(summary.map((s) => s.conceptCode)).toEqual(["K.2", "K.1"]);
    expect(summary[0]!.average).toBeCloseTo(0.3);
    expect(summary[0]!.assessed).toBe(2);
    // K.1: only A was assessed -> 0.9, not (0.9 + 0 + 0) / 3.
    expect(summary[1]!.average).toBeCloseTo(0.9);
    expect(summary[1]!.assessed).toBe(1);
  });

  it("detects the honest empty state", () => {
    expect(gridIsEmpty(buildGrid(result, [C]))).toBe(true);
    expect(gridIsEmpty(buildGrid(result, [A, C]))).toBe(false);
    expect(gridIsEmpty(buildGrid({ tenantId: TENANT, concepts: [], students: [] }, [A]))).toBe(true);
  });

  it("bands mastery values", () => {
    expect([0, 0.39, 0.4, 0.59, 0.6, 0.79, 0.8, 1].map(masteryLevel)).toEqual(["low", "low", "developing", "developing", "secure", "secure", "strong", "strong"]);
  });

  it("has every mastery message in sq/en/ar", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p];
    expect(keys(sq.mastery)).toEqual(keys(en.mastery));
    expect(keys(ar.mastery)).toEqual(keys(en.mastery));
    for (const m of [en, sq, ar]) expect(m.nav.mastery).toBeTruthy();
  });
});
