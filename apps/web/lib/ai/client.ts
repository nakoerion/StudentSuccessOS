/**
 * Thin typed client for `sso-ai`, the AI service. SERVER-ONLY: it carries the service token
 * (`SSO_AI_SERVICE_TOKEN`), which must never reach a browser bundle.
 *
 * Tenant-scoped: a client is bound to one tenant when it is created and injects that
 * `tenantId` into every request, so a caller cannot address another tenant's data.
 *
 * The service's product outcomes (answered | refused | handoff | unavailable) come back as
 * data, with the service's own `message` untouched — callers render it verbatim. Transport
 * and service failures become an `AiServiceError` with a small, typed `kind`.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/ai/client is server-only: it holds the sso-ai service token");
}

// ─── Contract (mirrors sso-ai src/tutor/tutor.ts and src/policy/policy.ts) ────────────────

export const TUTOR_MODES = ["socratic", "concept", "worked_example", "practice", "exam_prep", "writing_feedback"] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];
export const isTutorMode = (v: unknown): v is TutorMode => typeof v === "string" && (TUTOR_MODES as readonly string[]).includes(v);

export const AI_LANGUAGES = ["sq", "en", "ar"] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];

export type AssignmentAiPolicy = "allowed" | "guided" | "forbidden";

export interface TutorTurnRequest {
  studentId: string;
  /** Omit to start a new session; the result carries its id. */
  sessionId?: string;
  language: AiLanguage;
  mode?: TutorMode;
  input: string;
  subject: string;
  grade: number;
  /** ISO country of the tenant's pack (scopes curriculum retrieval). */
  country?: string;
  assignment?: { id: string; aiPolicy: AssignmentAiPolicy; conceptCodes?: string[] };
  conceptCodes?: string[];
  /** Restriction scopes, e.g. ["class:<uuid>", "student:<uuid>"]. */
  scopes?: string[];
  knownNames?: string[];
}

export interface TutorMastery {
  conceptCode: string;
  pMastery: number;
  attempts: number;
  correct: number;
}

export type TutorTurnResult =
  | {
      outcome: "answered";
      sessionId: string;
      text: string;
      mode: TutorMode;
      callId: string;
      promptVersion: string;
      concepts: string[];
      mastery: TutorMastery[];
      citations: { chunkId: string; curriculumCode: string | null; title: string; heading: string | null }[];
      memoryOff: boolean;
    }
  | { outcome: "refused"; sessionId: string; reason: string; message: string }
  | { outcome: "handoff"; sessionId: string; category: string; message: string; eventId: string }
  | { outcome: "unavailable"; sessionId: string; reason: string; message: string };

/** Mirrors sso-ai `GET /v1/mastery` (src/app.ts). */
export const MASTERY_MAX_STUDENTS = 200;

export interface MasteryCell {
  conceptCode: string;
  /** Bayesian Knowledge Tracing estimate, 0..1. */
  pMastery: number;
  attempts: number;
  correct: number;
  lastSeen: string;
}

export interface MasteryResult {
  tenantId: string;
  /** Sorted union of the concept codes found for these students. */
  concepts: string[];
  /** One entry per requested student; an empty `mastery` means no attempts yet (not zero). */
  students: { studentId: string; mastery: MasteryCell[] }[];
}

export interface MasteryRequest {
  studentIds: string[];
  conceptPrefix?: string;
}

/** Mirrors sso-ai `GET /v1/admin/usage` (src/gateway/usage.ts, src/gateway/budget.ts). */
export type BudgetPool = "discretionary" | "essential";

export interface PoolUsage {
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  usedRatio: number;
  warningRatio: number;
  warning: boolean;
  exhausted: boolean;
  hardStop: boolean;
  calls: number;
  fakeCalls: number;
}

export type DiscretionaryDerivation =
  | { basis: "explicit"; capUsd: number; seatCount: number | null }
  | { basis: "per_seat"; capUsd: number; seatCount: number; perSeatUsd: number; floorUsd: number }
  | { basis: "floor"; capUsd: number; seatCount: number | null; perSeatUsd: number; floorUsd: number };

export type EssentialDerivation =
  | { basis: "explicit"; capUsd: number }
  | { basis: "share"; capUsd: number; share: number }
  | { basis: "floor"; capUsd: number; floorUsd: number };

export interface UsageReport {
  tenantId: string;
  monthStart: string;
  currency: "USD";
  pools: Record<BudgetPool, PoolUsage>;
  derivation: { discretionary: DiscretionaryDerivation; essential: EssentialDerivation };
  /** No recorded call this month came from a live model: the spend figure is nominal. */
  nominal: boolean;
}

/** Mirrors sso-ai `GET /v1/admin/evals` (src/eval/store.ts). Runs are not tenant data. */
export type EvalProviderMode = "fake" | "live" | "mixed" | "none";

export interface EvalRun {
  id: string;
  suiteId: string;
  suiteKind: string;
  pack: string | null;
  subject: string | null;
  providerMode: EvalProviderMode;
  models: string[];
  cases: number;
  passed: number;
  plumbingScore: number;
  /** null when no live model answered: quality was not measured. */
  qualityScore: number | null;
  qualityMeasured: number;
  verdict: "pass" | "first_run" | "regression" | "below_floor";
  costUsd: number;
  startedAt: string;
  finishedAt: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type AiErrorKind =
  /** SSO_AI_URL / SSO_AI_SERVICE_TOKEN not set in this environment. */
  | "not_configured"
  /** Network failure, timeout, 5xx/503, or an unreadable response. */
  | "unreachable"
  /** The service rejected our service token (a deployment problem, not the user's). */
  | "unauthorized"
  | "session_not_found"
  /** Redaction could not clear personal data, so the call was blocked rather than sent. */
  | "pii_blocked"
  | "rate_limited"
  | "invalid_request";

export class AiServiceError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`sso-ai ${kind}${status ? ` (${status}${code ? ` ${code}` : ""})` : ""}`);
    this.name = "AiServiceError";
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface AiClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Reads SSO_AI_URL and SSO_AI_SERVICE_TOKEN; null when either is missing. */
export function aiConfigFromEnv(env: Record<string, string | undefined> = process.env): AiClientConfig | null {
  const baseUrl = env.SSO_AI_URL?.trim();
  const token = env.SSO_AI_SERVICE_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface AiClient {
  readonly tenantId: string;
  /** Authenticated liveness check: true when the service is up and accepts our token. */
  ping(): Promise<boolean>;
  tutorTurn(req: TutorTurnRequest): Promise<TutorTurnResult>;
  /** Traced mastery for up to MASTERY_MAX_STUDENTS students of the bound tenant. */
  mastery(req: MasteryRequest): Promise<MasteryResult>;
  /** The bound tenant's AI spend this month against both pool caps. */
  usage(): Promise<UsageReport>;
  /** Latest evaluation run per suite (service-wide, not tenant data). */
  latestEvals(): Promise<EvalRun[]>;
}

function isUsageReport(v: unknown): v is UsageReport {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const pools = r.pools as Record<string, Record<string, unknown> | undefined> | undefined;
  const deriv = r.derivation as Record<string, { basis?: unknown } | undefined> | undefined;
  const okPool = (p: Record<string, unknown> | undefined) =>
    !!p && typeof p.capUsd === "number" && typeof p.spentUsd === "number" && typeof p.warning === "boolean";
  return (
    typeof r.tenantId === "string" &&
    typeof r.nominal === "boolean" &&
    !!pools && okPool(pools.discretionary) && okPool(pools.essential) &&
    !!deriv && typeof deriv.discretionary?.basis === "string" && typeof deriv.essential?.basis === "string"
  );
}

function isEvalRuns(v: unknown): v is { runs: EvalRun[] } {
  if (!v || typeof v !== "object" || !Array.isArray((v as { runs?: unknown }).runs)) return false;
  return (v as { runs: unknown[] }).runs.every((x) => {
    const r = x as Record<string, unknown> | null;
    return !!r && typeof r.suiteId === "string" && typeof r.providerMode === "string" && typeof r.cases === "number";
  });
}

const ERROR_KINDS: Record<string, AiErrorKind> = {
  session_not_found: "session_not_found",
  pii_blocked: "pii_blocked",
  rate_limited: "rate_limited",
  invalid_request: "invalid_request",
  invalid_json: "invalid_request",
};

function errorFor(status: number, code: string | undefined): AiServiceError {
  if (status === 401) return new AiServiceError("unauthorized", status, code);
  const mapped = code ? ERROR_KINDS[code] : undefined;
  if (mapped && status < 500) return new AiServiceError(mapped, status, code);
  if (status === 400) return new AiServiceError("invalid_request", status, code);
  return new AiServiceError("unreachable", status, code);
}

function isTurnResult(v: unknown): v is TutorTurnResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.sessionId !== "string") return false;
  switch (r.outcome) {
    case "answered":
      return typeof r.text === "string";
    case "refused":
    case "handoff":
    case "unavailable":
      return typeof r.message === "string";
    default:
      return false;
  }
}

function isMasteryResult(v: unknown): v is MasteryResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.tenantId !== "string" || !Array.isArray(r.concepts) || !Array.isArray(r.students)) return false;
  return r.students.every((s: unknown) => {
    if (!s || typeof s !== "object") return false;
    const st = s as Record<string, unknown>;
    return (
      typeof st.studentId === "string" &&
      Array.isArray(st.mastery) &&
      st.mastery.every((m: unknown) => {
        const c = m as Record<string, unknown> | null;
        return !!c && typeof c.conceptCode === "string" && typeof c.pMastery === "number" && typeof c.attempts === "number";
      })
    );
  });
}

/**
 * Creates a client bound to one tenant. `config` defaults to the environment; when it is
 * absent every call fails with `not_configured` (the UI shows the unavailable state).
 */
export function createAiClient(tenantId: string, config: AiClientConfig | null = aiConfigFromEnv()): AiClient {
  if (!tenantId) throw new Error("createAiClient: tenantId is required");
  const doFetch = config?.fetch ?? fetch;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(method: "GET" | "POST", path: string, body?: unknown, timeout = timeoutMs): Promise<unknown> {
    if (!config) throw new AiServiceError("not_configured");
    let res: Response;
    try {
      res = await doFetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
        cache: "no-store",
      });
    } catch {
      throw new AiServiceError("unreachable");
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AiServiceError(res.ok ? "unreachable" : errorFor(res.status, undefined).kind, res.status);
    }
    if (!res.ok) {
      const code = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : undefined;
      throw errorFor(res.status, code);
    }
    return json;
  }

  return {
    tenantId,
    async ping() {
      try {
        const r = await call("GET", "/v1/ping", undefined, Math.min(timeoutMs, 3_000));
        return !!r && typeof r === "object" && (r as { ok?: unknown }).ok === true;
      } catch {
        return false;
      }
    },
    async tutorTurn(req) {
      // tenantId last: the bound tenant always wins over anything smuggled into req.
      const out = await call("POST", "/v1/tutor/turns", { ...req, tenantId });
      if (!isTurnResult(out)) throw new AiServiceError("unreachable", 200, "unexpected_response");
      return out;
    },
    async mastery(req) {
      const ids = [...new Set(req.studentIds)];
      if (ids.length === 0) return { tenantId, concepts: [], students: [] };
      if (ids.length > MASTERY_MAX_STUDENTS) throw new AiServiceError("invalid_request", undefined, "too_many_students");
      const qs = new URLSearchParams();
      for (const id of ids) qs.append("studentId", id);
      if (req.conceptPrefix) qs.set("conceptPrefix", req.conceptPrefix);
      // tenantId last: the bound tenant always wins.
      qs.set("tenantId", tenantId);
      const out = await call("GET", `/v1/mastery?${qs.toString()}`);
      if (!isMasteryResult(out) || out.tenantId !== tenantId) throw new AiServiceError("unreachable", 200, "unexpected_response");
      return out;
    },
    async usage() {
      const out = await call("GET", `/v1/admin/usage?${new URLSearchParams({ tenantId }).toString()}`);
      if (!isUsageReport(out) || out.tenantId !== tenantId) throw new AiServiceError("unreachable", 200, "unexpected_response");
      return out;
    },
    async latestEvals() {
      const out = await call("GET", "/v1/admin/evals");
      if (!isEvalRuns(out)) throw new AiServiceError("unreachable", 200, "unexpected_response");
      return out.runs;
    },
  };
}
