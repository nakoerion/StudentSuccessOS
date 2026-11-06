/**
 * Small helpers shared by the success-engine services (alerts, interventions, goals).
 * Internal: not re-exported from the package index.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export type Db = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isPrismaClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}

/** Run `fn` in a transaction: a new one on a client, the caller's one on a transaction. */
export function inTx<T>(db: PrismaClient | Db, fn: (tx: Db) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  return isPrismaClient(db) ? db.$transaction(fn, { timeout: timeoutMs, maxWait: 30_000 }) : fn(db);
}

/** UTC calendar date (time stripped). */
export const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Parse a YYYY-MM-DD string to a UTC date; null when malformed. */
export function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || isoDate(d) !== v ? null : d;
}

/** Calendar date of `at` in an IANA time zone (falls back to UTC for an unknown zone). */
export function localDate(at: Date, timeZone: string): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  } catch {
    return dateOnly(at);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

/** Monday of the ISO week containing the (UTC-midnight) date `d`. */
export function isoWeekStart(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * DAY_MS);
}

/** Does the person hold an active assignment of one of `roles` in the tenant at `now`? */
export async function hasActiveRole(db: PrismaClient | Db, tenantId: string, personId: string, roles: readonly string[], now: Date): Promise<boolean> {
  const row = await db.roleAssignment.findFirst({
    where: {
      tenantId,
      personId,
      status: "active",
      role: { key: { in: [...roles] } },
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
    },
    select: { id: true },
  });
  return row !== null;
}

/** Person of the tenant, or null (also for a malformed id). */
export async function findPerson(db: PrismaClient | Db, tenantId: string, personId: unknown): Promise<{ id: string } | null> {
  if (!isUuid(personId)) return null;
  return db.person.findFirst({ where: { tenantId, id: personId }, select: { id: true } });
}

/** Latest risk score of a student as { id, score } (exact decimal), or null. */
export async function latestRisk(db: PrismaClient | Db, tenantId: string, studentPersonId: string): Promise<{ id: string; score: Prisma.Decimal; computedAt: Date } | null> {
  return db.riskScore.findFirst({
    where: { tenantId, studentPersonId },
    orderBy: [{ computedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true, score: true, computedAt: true },
  });
}

/** Staff roles that run the success engine day to day. */
export const STAFF_ROLES = ["teacher", "advisor", "admin"] as const;
