/**
 * Attendance service (slice 3b of the academic record).
 *
 * An attendance event is one mark (present | late | absent | excused) for one
 * enrollment on one date, optionally for one timetable slot (period). Two ways in:
 *   - grid: a teacher marks a whole class section for a date (`markAttendanceFromGrid`);
 *   - QR:   the teacher shows a short-lived signed QR for a slot + date
 *           (`issueAttendanceQr`), the student scans it (`markAttendanceFromQr`) and is
 *           marked present.
 *
 * Every write records exactly ONE `event` row ("attendance.recorded") in the same
 * transaction as the attendance row (the event-per-mutation invariant).
 *
 * The attendance RATE is never stored here: it is derived by the materialised view
 * `attendance_rate_mv` (app-facing view `attendance_rate`), recomputed by the owner-only
 * `refresh_attendance_rate()` — see `refreshAttendanceRate` / `listAttendanceRates`.
 *
 * QR tokens are STATELESS (no table): base64url(JSON {tenantId, slotId, date, expiresAt})
 * + "." + base64url(HMAC-SHA256(payload)). The HMAC key is derived from the server-only
 * `SUPABASE_SECRET_KEY` environment variable: key = HMAC-SHA256(SUPABASE_SECRET_KEY,
 * "ssos:attendance-qr:v1"), so the raw secret is never used directly and rotating it
 * invalidates outstanding tokens (they live minutes anyway). tenantId is part of the
 * signed payload, so a token can never be replayed into another tenant.
 *
 * Writes need the owner role (ssos_owner, BYPASSRLS): every query filters by tenant_id
 * explicitly. Reads work on an owner client or inside `withTenant` (app role, RLS).
 * No code here branches on country.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { AttendanceMethod, AttendanceStatus, Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AttendanceErrorCode =
  | "bad_date"
  | "bad_status"
  | "bad_range"
  | "unknown_enrollment"
  | "student_mismatch"
  | "unknown_slot"
  | "slot_section_mismatch"
  | "unknown_section"
  | "out_of_range"
  | "not_enrolled"
  | "duplicate"
  | "invalid_token"
  | "expired_token";

/** Thrown by every attendance write for input that cannot be recorded. Nothing is written. */
export class AttendanceError extends Error {
  readonly code: AttendanceErrorCode;
  constructor(code: AttendanceErrorCode, message: string) {
    super(message);
    this.name = "AttendanceError";
    this.code = code;
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["present", "late", "absent", "excused"];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" (a real calendar day) -> the UTC-midnight Date Prisma writes to a DATE column; null if invalid. */
export function parseAttendanceDate(value: string): Date | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isoDate(d) === value.trim() ? d : null;
}

/** A DATE column value (UTC midnight) -> "YYYY-MM-DD". */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function requireDate(value: string): Date {
  const d = parseAttendanceDate(value ?? "");
  if (!d) throw new AttendanceError("bad_date", `date must be a calendar day YYYY-MM-DD, got "${value}"`);
  return d;
}

function requireStatus(status: string): AttendanceStatus {
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status))
    throw new AttendanceError("bad_status", `status must be one of ${ATTENDANCE_STATUSES.join(", ")}, got "${status}"`);
  return status as AttendanceStatus;
}

/**
 * The rate formula pinned by the `attendance_rate_mv` migration, as a pure function:
 * total = present + late + absent + excused; rate = ROUND(100 * (present + late) / total, 2).
 * "late" counts as attended; "excused" stays in the denominator. null when total = 0.
 */
export function attendanceRate(c: { present: number; late: number; absent: number; excused: number }): number | null {
  const total = c.present + c.late + c.absent + c.excused;
  if (total === 0) return null;
  // Round half away from zero on the exact hundredths value, like numeric ROUND().
  return Math.round(((c.present + c.late) * 10000) / total) / 100;
}

// ─── QR tokens (pure, stateless) ─────────────────────────────────────────────

export interface AttendanceQrPayload {
  tenantId: string;
  slotId: string;
  /** "YYYY-MM-DD" — the day the attendance is recorded for. */
  date: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

const QR_KEY_CONTEXT = "ssos:attendance-qr:v1";

/**
 * The HMAC key for attendance QR tokens, derived from the server-only
 * `SUPABASE_SECRET_KEY` (never hardcoded). Throws if the variable is missing.
 */
export function attendanceQrKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set: it is needed to sign attendance QR tokens");
  return createHmac("sha256", secret).update(QR_KEY_CONTEXT).digest();
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Sign a payload: base64url(JSON) "." base64url(HMAC-SHA256). */
export function signAttendanceToken(payload: AttendanceQrPayload, key: Buffer): string {
  const body = b64url(
    Buffer.from(
      JSON.stringify({ tenantId: payload.tenantId, slotId: payload.slotId, date: payload.date, expiresAt: payload.expiresAt }),
      "utf8",
    ),
  );
  return `${body}.${b64url(createHmac("sha256", key).update(body).digest())}`;
}

/**
 * Verify signature (constant time) and expiry. Throws AttendanceError
 * `invalid_token` (malformed / bad signature / bad payload) or `expired_token`.
 */
export function verifyAttendanceToken(token: string, key: Buffer, now: number = Date.now()): AttendanceQrPayload {
  const parts = typeof token === "string" ? token.trim().split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AttendanceError("invalid_token", "malformed attendance token");
  const [body, sig] = parts as [string, string];
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new AttendanceError("invalid_token", "attendance token signature does not match");
  let p: Partial<AttendanceQrPayload>;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<AttendanceQrPayload>;
  } catch {
    throw new AttendanceError("invalid_token", "attendance token payload is not JSON");
  }
  if (
    typeof p.tenantId !== "string" ||
    typeof p.slotId !== "string" ||
    typeof p.date !== "string" ||
    !parseAttendanceDate(p.date) ||
    typeof p.expiresAt !== "number" ||
    !Number.isFinite(p.expiresAt)
  )
    throw new AttendanceError("invalid_token", "attendance token payload is incomplete");
  if (now >= p.expiresAt) throw new AttendanceError("expired_token", `attendance token expired at ${new Date(p.expiresAt).toISOString()}`);
  return { tenantId: p.tenantId, slotId: p.slotId, date: p.date, expiresAt: p.expiresAt };
}

// ─── Database: shared write path ─────────────────────────────────────────────

export interface AttendanceView {
  id: string;
  tenantId: string;
  enrollmentId: string;
  studentPersonId: string;
  classSectionId: string;
  timetableSlotId: string | null;
  /** "YYYY-MM-DD" */
  date: string;
  status: AttendanceStatus;
  method: AttendanceMethod;
  recordedByPersonId: string | null;
  comment: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function isPrismaClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}

function inTx<T>(db: PrismaClient | Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return isPrismaClient(db) ? db.$transaction(fn, { timeout: 60_000, maxWait: 30_000 }) : fn(db);
}

interface ResolvedSlot {
  id: string;
  classSectionId: string;
  /** Inclusive validity range of the slot: its term, or its section's academic year. */
  from: Date;
  to: Date;
}

/** Slot in tenant + the date range it is valid for. Throws `unknown_slot`. */
async function resolveSlot(db: Db, tenantId: string, slotId: string): Promise<ResolvedSlot> {
  const slot = isUuid(slotId)
    ? await db.timetableSlot.findFirst({
        where: { tenantId, id: slotId },
        select: {
          id: true,
          classSectionId: true,
          term: { select: { startsOn: true, endsOn: true } },
          classSection: { select: { course: { select: { academicYear: { select: { startsOn: true, endsOn: true } } } } } },
        },
      })
    : null;
  if (!slot) throw new AttendanceError("unknown_slot", `timetable slot ${slotId} not found in tenant`);
  const range = slot.term ?? slot.classSection.course.academicYear;
  return { id: slot.id, classSectionId: slot.classSectionId, from: range.startsOn, to: range.endsOn };
}

function assertInRange(date: Date, from: Date, to: Date, what: string): void {
  if (date < from || date > to)
    throw new AttendanceError("out_of_range", `date ${isoDate(date)} is outside ${what} ${isoDate(from)}..${isoDate(to)}`);
}

interface WriteRow {
  tenantId: string;
  enrollmentId: string;
  studentPersonId: string;
  classSectionId: string;
  timetableSlotId: string | null;
  date: Date;
  status: AttendanceStatus;
  method: AttendanceMethod;
  recordedByPersonId: string | null;
  actorUserId: string | null;
  comment: string | null;
}

/**
 * Insert one validated attendance row + its one Event, inside `db`'s transaction.
 * Rejects an existing mark for the same (enrollment, date, slot) with `duplicate` —
 * including slot NULL (whole-day marks), which the unique index alone would not catch
 * because NULLs are distinct in Postgres. A per-(enrollment, date) advisory lock makes
 * the check-and-insert safe against concurrent writers.
 */
async function insertOne(db: Db, row: WriteRow): Promise<AttendanceView> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:attendance:${row.tenantId}:${row.enrollmentId}:${isoDate(row.date)}`}))`;
  const existing = await db.attendanceEvent.findFirst({
    where: { tenantId: row.tenantId, enrollmentId: row.enrollmentId, date: row.date, timetableSlotId: row.timetableSlotId },
    select: { id: true },
  });
  if (existing)
    throw new AttendanceError(
      "duplicate",
      `attendance already recorded for student ${row.studentPersonId} on ${isoDate(row.date)}` +
        (row.timetableSlotId ? ` (slot ${row.timetableSlotId})` : " (whole day)"),
    );
  let created;
  try {
    created = await db.attendanceEvent.create({
      data: {
        tenantId: row.tenantId,
        enrollmentId: row.enrollmentId,
        studentPersonId: row.studentPersonId,
        timetableSlotId: row.timetableSlotId,
        date: row.date,
        status: row.status,
        method: row.method,
        recordedByPersonId: row.recordedByPersonId,
        comment: row.comment,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002")
      throw new AttendanceError("duplicate", `attendance already recorded for student ${row.studentPersonId} on ${isoDate(row.date)}`);
    throw e;
  }
  const payload: Record<string, string> = { status: row.status, method: row.method, date: isoDate(row.date) };
  if (row.timetableSlotId) payload.slotId = row.timetableSlotId;
  await db.event.create({
    data: {
      tenantId: row.tenantId,
      type: "attendance.recorded",
      actorPersonId: row.recordedByPersonId,
      actorUserId: row.actorUserId,
      subjectPersonId: row.studentPersonId,
      entityType: "attendance_event",
      entityId: created.id,
      payload,
    },
  });
  return {
    id: created.id,
    tenantId: created.tenantId,
    enrollmentId: created.enrollmentId,
    studentPersonId: created.studentPersonId,
    classSectionId: row.classSectionId,
    timetableSlotId: created.timetableSlotId,
    date: isoDate(created.date),
    status: created.status,
    method: created.method,
    recordedByPersonId: created.recordedByPersonId,
    comment: created.comment,
  };
}

/** The section's academic-year range (used when no slot narrows it to a term). */
async function sectionYearRange(db: Db, tenantId: string, classSectionId: string): Promise<{ from: Date; to: Date } | null> {
  const s = await db.classSection.findFirst({
    where: { tenantId, id: classSectionId },
    select: { course: { select: { academicYear: { select: { startsOn: true, endsOn: true } } } } },
  });
  return s ? { from: s.course.academicYear.startsOn, to: s.course.academicYear.endsOn } : null;
}

// ─── Database: recordAttendance ──────────────────────────────────────────────

export interface RecordAttendanceInput {
  tenantId: string;
  enrollmentId: string;
  studentPersonId: string;
  /** "YYYY-MM-DD" */
  date: string;
  status: AttendanceStatus;
  /** Period the mark is for; omitted/null = whole-day mark. Must be a slot of the enrollment's section. */
  timetableSlotId?: string | null;
  /** Default "grid". */
  method?: AttendanceMethod;
  /** Person who recorded the mark (Event actor). Null = system. */
  recordedByPersonId?: string | null;
  /** Auth identity of the actor, for the Event. */
  actorUserId?: string | null;
  comment?: string | null;
}

async function recordInTx(db: Db, input: RecordAttendanceInput): Promise<AttendanceView> {
  const { tenantId } = input;
  const date = requireDate(input.date);
  const status = requireStatus(input.status);
  const enrollment = isUuid(input.enrollmentId)
    ? await db.enrollment.findFirst({
        where: { tenantId, id: input.enrollmentId },
        select: { id: true, classSectionId: true, studentPersonId: true },
      })
    : null;
  if (!enrollment) throw new AttendanceError("unknown_enrollment", `enrollment ${input.enrollmentId} not found in tenant`);
  if (enrollment.studentPersonId !== input.studentPersonId)
    throw new AttendanceError(
      "student_mismatch",
      `student ${input.studentPersonId} is not the student of enrollment ${enrollment.id}`,
    );

  const slotId = input.timetableSlotId ?? null;
  if (slotId) {
    const slot = await resolveSlot(db, tenantId, slotId);
    if (slot.classSectionId !== enrollment.classSectionId)
      throw new AttendanceError("slot_section_mismatch", `slot ${slotId} is not a period of the enrollment's class section`);
    assertInRange(date, slot.from, slot.to, "the slot's term/year");
  } else {
    const year = (await sectionYearRange(db, tenantId, enrollment.classSectionId))!;
    assertInRange(date, year.from, year.to, "the academic year");
  }

  return insertOne(db, {
    tenantId,
    enrollmentId: enrollment.id,
    studentPersonId: enrollment.studentPersonId,
    classSectionId: enrollment.classSectionId,
    timetableSlotId: slotId,
    date,
    status,
    method: input.method ?? "grid",
    recordedByPersonId: input.recordedByPersonId ?? null,
    actorUserId: input.actorUserId ?? null,
    comment: input.comment?.trim() || null,
  });
}

/**
 * Record one attendance mark (+ exactly one "attendance.recorded" Event), or throw
 * `AttendanceError` and write nothing. `db` must be an OWNER-role client or transaction;
 * given a PrismaClient the validation + insert run in their own transaction.
 */
export function recordAttendance(db: PrismaClient | Db, input: RecordAttendanceInput): Promise<AttendanceView> {
  return inTx(db, (tx) => recordInTx(tx, input));
}

// ─── Database: grid ──────────────────────────────────────────────────────────

export interface GridAttendanceRow {
  studentPersonId: string;
  status: AttendanceStatus;
  comment?: string | null;
}

export interface MarkAttendanceFromGridOptions {
  tenantId: string;
  /** Period the grid is for; omitted/null = whole-day marks. Must belong to the section. */
  timetableSlotId?: string | null;
  recordedByPersonId?: string | null;
  actorUserId?: string | null;
}

/**
 * Record a whole section's attendance for one date (method "grid"). All-or-nothing:
 * every row must be a student ACTIVELY enrolled in the section (else `not_enrolled`),
 * no student may appear twice and none may already be marked (`duplicate`). Each row
 * writes exactly one Event. Returns the rows in input order.
 */
export function markAttendanceFromGrid(
  db: PrismaClient | Db,
  sectionId: string,
  date: string,
  rows: readonly GridAttendanceRow[],
  opts: MarkAttendanceFromGridOptions,
): Promise<AttendanceView[]> {
  return inTx(db, async (tx) => {
    const { tenantId } = opts;
    const day = requireDate(date);
    const section = isUuid(sectionId)
      ? await tx.classSection.findFirst({ where: { tenantId, id: sectionId }, select: { id: true } })
      : null;
    if (!section) throw new AttendanceError("unknown_section", `class section ${sectionId} not found in tenant`);

    const slotId = opts.timetableSlotId ?? null;
    if (slotId) {
      const slot = await resolveSlot(tx, tenantId, slotId);
      if (slot.classSectionId !== section.id)
        throw new AttendanceError("slot_section_mismatch", `slot ${slotId} is not a period of class section ${section.id}`);
      assertInRange(day, slot.from, slot.to, "the slot's term/year");
    } else {
      const year = (await sectionYearRange(tx, tenantId, section.id))!;
      assertInRange(day, year.from, year.to, "the academic year");
    }

    const enrollments = await tx.enrollment.findMany({
      where: { tenantId, classSectionId: section.id, status: "active" },
      select: { id: true, studentPersonId: true },
    });
    const byStudent = new Map(enrollments.map((e) => [e.studentPersonId, e.id]));
    const seen = new Set<string>();
    // Validate every row before writing any.
    const plan = rows.map((r) => {
      const status = requireStatus(r.status);
      const enrollmentId = byStudent.get(r.studentPersonId);
      if (!enrollmentId)
        throw new AttendanceError("not_enrolled", `student ${r.studentPersonId} is not actively enrolled in section ${section.id}`);
      if (seen.has(r.studentPersonId))
        throw new AttendanceError("duplicate", `student ${r.studentPersonId} appears more than once in the grid`);
      seen.add(r.studentPersonId);
      return { r, status, enrollmentId };
    });

    const out: AttendanceView[] = [];
    for (const { r, status, enrollmentId } of plan) {
      out.push(
        await insertOne(tx, {
          tenantId,
          enrollmentId,
          studentPersonId: r.studentPersonId,
          classSectionId: section.id,
          timetableSlotId: slotId,
          date: day,
          status,
          method: "grid",
          recordedByPersonId: opts.recordedByPersonId ?? null,
          actorUserId: opts.actorUserId ?? null,
          comment: r.comment?.trim() || null,
        }),
      );
    }
    return out;
  });
}

// ─── Database: QR ────────────────────────────────────────────────────────────

export interface IssueAttendanceQrOptions {
  tenantId: string;
  /** Token lifetime. Default 15 minutes; must be 1..1440. */
  expiresInMinutes?: number;
  /** Override the signing key (tests). Default: derived from SUPABASE_SECRET_KEY. */
  key?: Buffer;
  /** Clock override (tests), epoch ms. */
  now?: number;
}

export const DEFAULT_QR_EXPIRY_MINUTES = 15;

/**
 * Issue a stateless signed QR token for (slot, date). Validates the slot exists in the
 * tenant and the date is inside the slot's term/year. Writes nothing.
 */
export async function issueAttendanceQr(
  db: PrismaClient | Db,
  slotId: string,
  date: string,
  opts: IssueAttendanceQrOptions,
): Promise<{ token: string; expiresAt: Date; payload: AttendanceQrPayload }> {
  const minutes = opts.expiresInMinutes ?? DEFAULT_QR_EXPIRY_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
    throw new RangeError(`expiresInMinutes must be in (0, 1440], got ${minutes}`);
  const day = requireDate(date);
  const slot = await resolveSlot(db as Db, opts.tenantId, slotId);
  assertInRange(day, slot.from, slot.to, "the slot's term/year");
  const payload: AttendanceQrPayload = {
    tenantId: opts.tenantId,
    slotId: slot.id,
    date: isoDate(day),
    expiresAt: (opts.now ?? Date.now()) + Math.round(minutes * 60_000),
  };
  return { token: signAttendanceToken(payload, opts.key ?? attendanceQrKey()), expiresAt: new Date(payload.expiresAt), payload };
}

export interface MarkAttendanceFromQrOptions {
  /** When set, the token must have been issued for this tenant (else `invalid_token`). */
  tenantId?: string;
  key?: Buffer;
  now?: number;
  actorUserId?: string | null;
}

/**
 * A student scanned a QR: verify it, find the student's ACTIVE enrollment in the slot's
 * section and record `present` with method "qr" (+ one Event, actor = the student).
 * Throws `invalid_token`, `expired_token`, `not_enrolled`, `duplicate` (or the
 * recordAttendance range codes).
 */
export function markAttendanceFromQr(
  db: PrismaClient | Db,
  token: string,
  studentPersonId: string,
  opts: MarkAttendanceFromQrOptions = {},
): Promise<AttendanceView> {
  const payload = verifyAttendanceToken(token, opts.key ?? attendanceQrKey(), opts.now ?? Date.now());
  if (opts.tenantId !== undefined && opts.tenantId !== payload.tenantId)
    return Promise.reject(new AttendanceError("invalid_token", "attendance token was issued for another tenant"));
  const { tenantId } = payload;
  return inTx(db, async (tx) => {
    let slot: ResolvedSlot;
    try {
      slot = await resolveSlot(tx, tenantId, payload.slotId);
    } catch (e) {
      if (e instanceof AttendanceError) throw new AttendanceError("invalid_token", `attendance token refers to an unknown slot`);
      throw e;
    }
    const enrollment = isUuid(studentPersonId)
      ? await tx.enrollment.findFirst({
          where: { tenantId, classSectionId: slot.classSectionId, studentPersonId, status: "active" },
          select: { id: true },
        })
      : null;
    if (!enrollment)
      throw new AttendanceError("not_enrolled", `student ${studentPersonId} is not actively enrolled in the slot's section`);
    return recordInTx(tx, {
      tenantId,
      enrollmentId: enrollment.id,
      studentPersonId,
      date: payload.date,
      status: "present",
      method: "qr",
      timetableSlotId: slot.id,
      recordedByPersonId: studentPersonId,
      actorUserId: opts.actorUserId ?? null,
    });
  });
}

// ─── Database: reads ─────────────────────────────────────────────────────────

export interface AttendanceRangeOptions {
  /** Inclusive "YYYY-MM-DD" bounds; omitted = open. */
  from?: string;
  to?: string;
}

const LIST_SELECT = {
  id: true,
  tenantId: true,
  enrollmentId: true,
  studentPersonId: true,
  timetableSlotId: true,
  date: true,
  status: true,
  method: true,
  recordedByPersonId: true,
  comment: true,
  enrollment: { select: { classSectionId: true } },
} satisfies Prisma.AttendanceEventSelect;

async function list(
  db: Db | PrismaClient,
  tenantId: string,
  where: Prisma.AttendanceEventWhereInput,
  range: AttendanceRangeOptions,
): Promise<AttendanceView[]> {
  const date: Prisma.DateTimeFilter = {};
  if (range.from !== undefined) date.gte = requireDate(range.from);
  if (range.to !== undefined) date.lte = requireDate(range.to);
  if (date.gte && date.lte && date.gte > date.lte) throw new AttendanceError("bad_range", `from ${range.from} is after to ${range.to}`);
  const rows = await db.attendanceEvent.findMany({
    where: { AND: [{ tenantId }, where, { date }] },
    select: LIST_SELECT,
    orderBy: [{ date: "asc" }, { studentPersonId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    enrollmentId: r.enrollmentId,
    studentPersonId: r.studentPersonId,
    classSectionId: r.enrollment.classSectionId,
    timetableSlotId: r.timetableSlotId,
    date: isoDate(r.date),
    status: r.status,
    method: r.method,
    recordedByPersonId: r.recordedByPersonId,
    comment: r.comment,
  }));
}

/** A section's attendance in [from, to], ordered by date then student. */
export function listAttendanceForSection(
  db: Db | PrismaClient,
  args: { tenantId: string; sectionId: string } & AttendanceRangeOptions,
): Promise<AttendanceView[]> {
  return list(db, args.tenantId, { enrollment: { classSectionId: args.sectionId } }, args);
}

/** A student's attendance across all sections in [from, to], ordered by date. */
export function listAttendanceForStudent(
  db: Db | PrismaClient,
  args: { tenantId: string; studentPersonId: string } & AttendanceRangeOptions,
): Promise<AttendanceView[]> {
  return list(db, args.tenantId, { studentPersonId: args.studentPersonId }, args);
}

// ─── Database: derived rate ──────────────────────────────────────────────────

export interface AttendanceRateRow {
  tenantId: string;
  studentPersonId: string;
  /** null = the events fell in no term ("unassigned"). */
  termId: string | null;
  present: number;
  late: number;
  absent: number;
  excused: number;
  total: number;
  /** 0..100 with 2 decimals; null when total = 0. */
  presentRate: number | null;
}

/** Recompute `attendance_rate_mv`. OWNER role only (the app role cannot execute it). */
export async function refreshAttendanceRate(db: PrismaClient | Db): Promise<void> {
  await db.$executeRaw`SELECT refresh_attendance_rate()`;
}

/**
 * Attendance rates from the app-facing `attendance_rate` view, which filters by the
 * CURRENT tenant (app.tenant_id) — call inside `withTenant`. Ordered by student, term.
 */
export async function listAttendanceRates(
  db: Db,
  args: { studentPersonId?: string; termId?: string } = {},
): Promise<AttendanceRateRow[]> {
  const rows = await db.$queryRaw<
    {
      tenant_id: string;
      student_person_id: string;
      term_id: string | null;
      present: number;
      late: number;
      absent: number;
      excused: number;
      total: number;
      present_rate: string | null;
    }[]
  >`
    SELECT tenant_id::text, student_person_id::text, term_id::text, present, late, absent, excused, total,
           present_rate::text AS present_rate
    FROM attendance_rate
    WHERE (${args.studentPersonId ?? null}::uuid IS NULL OR student_person_id = ${args.studentPersonId ?? null}::uuid)
      AND (${args.termId ?? null}::uuid IS NULL OR term_id = ${args.termId ?? null}::uuid)
    ORDER BY student_person_id, term_id NULLS LAST`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    studentPersonId: r.student_person_id,
    termId: r.term_id,
    present: r.present,
    late: r.late,
    absent: r.absent,
    excused: r.excused,
    total: r.total,
    presentRate: r.present_rate === null ? null : Number(r.present_rate),
  }));
}
