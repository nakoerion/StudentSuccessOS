/**
 * Seat-count sync (seat-count-sync-spec.md §3–4): count every tenant's active student seats
 * and push the number to `sso-ai` (PUT /v1/tenants/:tenantId/seats). Only the tenant id and an
 * integer leave this process — no names, no emails.
 *
 * Per-tenant failures (sso-ai unreachable, rejected) are reported and skipped: the service
 * keeps its previous value, and the caller (CLI or nightly job) is never failed by them.
 */
import { listTenantSeats, type Prisma, type PrismaClient } from "@ssos/db";

/** Mirrors sso-ai `PUT /v1/tenants/:tenantId/seats` (sso-ai src/app.ts). */
export interface SeatsResponse {
  tenantId: string;
  seats: number | null;
  caps: { discretionary: number; essential: number };
  derivation: { discretionary: { basis: string; capUsd: number }; essential: { basis: string; capUsd: number } };
}

export type PushSeats = (tenantId: string, seats: number) => Promise<SeatsResponse>;

export type SeatSyncLine =
  | { status: "synced"; tenantId: string; slug: string; seats: number; capUsd: number; basis: string }
  | { status: "failed"; tenantId: string; slug: string; seats: number; error: string };

export interface SeatSyncResult {
  tenants: number;
  synced: number;
  failed: number;
  lines: SeatSyncLine[];
}

export async function syncSeatCounts(db: PrismaClient | Prisma.TransactionClient, push: PushSeats): Promise<SeatSyncResult> {
  const lines: SeatSyncLine[] = [];
  for (const t of await listTenantSeats(db)) {
    try {
      const r = await push(t.tenantId, t.seats);
      lines.push({ status: "synced", tenantId: t.tenantId, slug: t.slug, seats: t.seats, capUsd: r.caps.discretionary, basis: r.derivation.discretionary.basis });
    } catch (e) {
      lines.push({ status: "failed", tenantId: t.tenantId, slug: t.slug, seats: t.seats, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const synced = lines.filter((l) => l.status === "synced").length;
  return { tenants: lines.length, synced, failed: lines.length - synced, lines };
}

/** One human-readable line per tenant: slug, seats, resulting cap. */
export function formatSeatSyncLine(l: SeatSyncLine): string {
  return l.status === "synced"
    ? `${l.slug}\tseats=${l.seats}\tcap=$${l.capUsd.toFixed(2)} (${l.basis})`
    : `${l.slug}\tseats=${l.seats}\tNOT SYNCED: ${l.error} (sso-ai keeps its previous value)`;
}

export interface SeatPusherConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Reads SSO_AI_URL and SSO_AI_SERVICE_TOKEN; null when either is missing. */
export function seatPusherConfigFromEnv(env: Record<string, string | undefined> = process.env): SeatPusherConfig | null {
  const baseUrl = env.SSO_AI_URL?.trim();
  const token = env.SSO_AI_SERVICE_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** HTTP pusher to sso-ai with the service token. Throws on any non-2xx or malformed answer. */
export function createSeatPusher(config: SeatPusherConfig): PushSeats {
  const doFetch = config.fetch ?? fetch;
  return async (tenantId, seats) => {
    if (!Number.isInteger(seats) || seats < 0) throw new Error(`invalid seat count ${seats}`);
    let res: Response;
    try {
      res = await doFetch(`${config.baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/seats`, {
        method: "PUT",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ seats }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });
    } catch {
      throw new Error("sso-ai unreachable");
    }
    if (!res.ok) throw new Error(`sso-ai answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as SeatsResponse | null;
    if (!body || body.tenantId !== tenantId || typeof body.caps?.discretionary !== "number") throw new Error("sso-ai unexpected response");
    return body;
  };
}
