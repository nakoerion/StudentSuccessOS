/**
 * sso-ai client: service-token auth, tenant binding, verbatim pass-through of the service's
 * product outcomes, and the typed error mapping the tutor screen relies on. Also checks the
 * tutor's messages exist in sq/en/ar with the same keys.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import ar from "../messages/ar.json";
import en from "../messages/en.json";
import sq from "../messages/sq.json";
import { aiConfigFromEnv, AiServiceError, createAiClient, TUTOR_MODES } from "../lib/ai/client";
import { parseGrade } from "../lib/ai/tutor";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TOKEN = "test-service-token-0123456789abcdef";
const BUDGET_AR = "استهلك المعلّم الذكي رصيد المدرسة من الذكاء الاصطناعي لهذا الشهر، لذلك لا يمكنه الإجابة الآن.";

type Reply = { status: number; body: unknown };
let reply: Reply = { status: 200, body: {} };
let lastRequest: { url: string; auth: string | undefined; body: Record<string, unknown> | null } | null = null;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      lastRequest = { url: req.url ?? "", auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = (tenantId = TENANT, token = TOKEN) => createAiClient(tenantId, { baseUrl, token, timeoutMs: 2_000 });
const turn = { studentId: STUDENT, language: "en" as const, mode: "socratic" as const, input: "What is a prime?", subject: "Mathematics", grade: 10 };

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof AiServiceError ? err.kind : `other:${String(err)}`;
  }
}

describe("aiConfigFromEnv", () => {
  it("needs both variables and trims a trailing slash", () => {
    expect(aiConfigFromEnv({})).toBeNull();
    expect(aiConfigFromEnv({ SSO_AI_URL: "http://ai" })).toBeNull();
    expect(aiConfigFromEnv({ SSO_AI_URL: "http://ai/", SSO_AI_SERVICE_TOKEN: "t" })).toEqual({ baseUrl: "http://ai", token: "t" });
  });
});

describe("createAiClient", () => {
  it("sends the bearer token and always the bound tenant", async () => {
    reply = { status: 200, body: { outcome: "answered", sessionId: SESSION, text: "What divides it?", mode: "socratic", callId: "c", promptVersion: "v", concepts: [], mastery: [], citations: [], memoryOff: false } };
    const smuggled = { ...turn, tenantId: OTHER_TENANT } as typeof turn;
    const r = await client().tutorTurn(smuggled);
    expect(r.outcome).toBe("answered");
    expect(lastRequest?.url).toBe("/v1/tutor/turns");
    expect(lastRequest?.auth).toBe(`Bearer ${TOKEN}`);
    expect(lastRequest?.body?.tenantId).toBe(TENANT);
  });

  it("passes refusal, budget and hand-off messages through byte for byte", async () => {
    for (const body of [
      { outcome: "unavailable", sessionId: SESSION, reason: "budget_exceeded", message: BUDGET_AR },
      { outcome: "refused", sessionId: SESSION, reason: "assignment_forbids_ai", message: "Mësuesi yt kërkon që këtë detyrë ta bësh pa tutorin AI." },
      { outcome: "handoff", sessionId: SESSION, category: "self_harm", eventId: "e", message: "Please talk to someone you trust." },
    ]) {
      reply = { status: 200, body };
      expect(await client().tutorTurn(turn)).toEqual(body);
    }
  });

  it("maps service errors to typed kinds", async () => {
    const cases: [Reply, string][] = [
      [{ status: 404, body: { error: "session_not_found" } }, "session_not_found"],
      [{ status: 422, body: { error: "pii_blocked" } }, "pii_blocked"],
      [{ status: 429, body: { error: "rate_limited" } }, "rate_limited"],
      [{ status: 400, body: { error: "invalid_request" } }, "invalid_request"],
      [{ status: 503, body: { error: "agent_not_configured" } }, "unreachable"],
      [{ status: 500, body: { error: "internal_error" } }, "unreachable"],
      [{ status: 200, body: { nope: true } }, "unreachable"],
    ];
    for (const [r, kind] of cases) {
      reply = r;
      expect(await kindOf(client().tutorTurn(turn))).toBe(kind);
    }
    expect(await kindOf(client(TENANT, "wrong-token").tutorTurn(turn))).toBe("unauthorized");
  });

  it("reports unreachable and not_configured, and ping is false for both", async () => {
    const dead = createAiClient(TENANT, { baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 1_000 });
    expect(await kindOf(dead.tutorTurn(turn))).toBe("unreachable");
    expect(await dead.ping()).toBe(false);
    const unset = createAiClient(TENANT, null);
    expect(await kindOf(unset.tutorTurn(turn))).toBe("not_configured");
    expect(await unset.ping()).toBe(false);
    reply = { status: 200, body: { ok: true, region: "eu-central" } };
    expect(await client().ping()).toBe(true);
  });
});

describe("tutor screen helpers", () => {
  it("parses pack grade labels", () => {
    expect(parseGrade("10")).toBe(10);
    expect(parseGrade("Grade 12")).toBe(12);
    expect(parseGrade("Year")).toBeNull();
    expect(parseGrade("40")).toBeNull();
  });

  it("has every tutor message in sq/en/ar, one label per mode", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p];
    expect(keys(sq.tutor)).toEqual(keys(en.tutor));
    expect(keys(ar.tutor)).toEqual(keys(en.tutor));
    expect(Object.keys(en.tutor.modes).sort()).toEqual([...TUTOR_MODES].sort());
    for (const m of [en, sq, ar]) expect(m.nav.tutor).toBeTruthy();
  });
});
