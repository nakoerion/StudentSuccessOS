/**
 * Timetable service (slice 3a of the academic record).
 *
 * A timetable slot is a weekly recurring period: (class_section, ISO weekday,
 * [startsAt, endsAt)), optionally with a teacher assignment, a room and a term
 * (term NULL = every term of the year).
 *
 * Two halves, like the setup wizard:
 *   - PURE helpers (`parseTime`, `hasTimeOverlap`, `findSlotConflict`): no I/O, the
 *     conflict rules are unit-testable without a database.
 *   - Database functions: `createTimetableSlot` (owner role, rejects conflicts with a
 *     typed error) and the grid queries `listTimetableFor{Student,Teacher,Room}`
 *     (any client: an owner client, or a `withTenant` transaction on the app role).
 *
 * Conflict rules (two slots can only clash when they are on the same weekday, their
 * half-open time ranges overlap, and their terms overlap — equal, or either is NULL;
 * candidates are limited to the same academic year):
 *   duplicate — exact same section/day/times/teacher assignment/room/term already exists;
 *   section   — the same class section is already scheduled;
 *   teacher   — the slot's teacher (person behind the teacher assignment) is already teaching;
 *   room      — the same room (trimmed, case-insensitive) is already in use;
 *   student   — a student actively enrolled in this section is actively enrolled in
 *               another section that is already scheduled.
 *
 * Writes need the owner role (ssos_owner, BYPASSRLS): every query filters by
 * tenant_id explicitly. No code here branches on country.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type SlotConflictKind = "duplicate" | "section" | "teacher" | "room" | "student";

export interface SlotConflict {
  kind: SlotConflictKind;
  /** The existing slot the candidate collides with. */
  slotId: string;
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
  classSectionId: string;
  /** Set for kind = "teacher". */
  teacherPersonId?: string;
  /** Set for kind = "room". */
  room?: string;
  /** Set for kind = "student" (the first clashing student, by id). */
  studentPersonId?: string;
}

/** Thrown by `createTimetableSlot` when the slot would double-book something. */
export class TimetableConflictError extends Error {
  readonly conflict: SlotConflict;
  constructor(conflict: SlotConflict) {
    const who =
      conflict.kind === "teacher"
        ? ` (teacher ${conflict.teacherPersonId})`
        : conflict.kind === "room"
          ? ` (room ${conflict.room})`
          : conflict.kind === "student"
            ? ` (student ${conflict.studentPersonId})`
            : "";
    super(
      `timetable ${conflict.kind} conflict${who} with slot ${conflict.slotId} ` +
        `on day ${conflict.dayOfWeek} ${conflict.startsAt}-${conflict.endsAt}`,
    );
    this.name = "TimetableConflictError";
    this.conflict = conflict;
  }
}

export type TimetableValidationCode =
  | "bad_day"
  | "bad_time"
  | "unknown_section"
  | "unknown_teacher_assignment"
  | "unknown_term";

/** Thrown by `createTimetableSlot` for input that can never be a valid slot. */
export class TimetableValidationError extends Error {
  readonly code: TimetableValidationCode;
  constructor(code: TimetableValidationCode, message: string) {
    super(message);
    this.name = "TimetableValidationError";
    this.code = code;
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** "HH:MM" or "HH:MM:SS" (24h) -> minutes after midnight; null if malformed. Seconds are dropped. */
export function parseTime(value: string): number | null {
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes after midnight -> "HH:MM". */
export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A Postgres TIME read by Prisma (1970-01-01THH:MM:SSZ) -> "HH:MM". */
export function timeOfDate(d: Date): string {
  return formatTime(d.getUTCHours() * 60 + d.getUTCMinutes());
}

/** "HH:MM" -> the Date Prisma writes to a TIME column. */
function dateOfTime(minutes: number): Date {
  return new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
}

export function isValidDayOfWeek(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 7;
}

/** Half-open [startsAt, endsAt) ranges overlap. Adjacent periods (08:45 end, 08:45 start) do not. */
export function hasTimeOverlap(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean {
  const [as, ae, bs, be] = [a.startsAt, a.endsAt, b.startsAt, b.endsAt].map(parseTime);
  if (as == null || ae == null || bs == null || be == null) throw new Error("hasTimeOverlap: malformed time");
  return as < be && bs < ae;
}

/** Normalised room key: trimmed, case-insensitive; empty = no room. */
export function roomKey(room: string | null | undefined): string | null {
  const r = room?.trim();
  return r ? r.toLowerCase() : null;
}

/** The facts the conflict rules need about one slot. */
export interface ConflictSlot {
  /** Absent for the candidate. */
  id?: string;
  classSectionId: string;
  teacherAssignmentId: string | null;
  /** Person behind the teacher assignment (null when the slot has no assignment). */
  teacherPersonId: string | null;
  room: string | null;
  termId: string | null;
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
  /** Students actively enrolled in the slot's section. */
  studentPersonIds: readonly string[];
}

const termsOverlap = (a: string | null, b: string | null) => a === null || b === null || a === b;

/**
 * First conflict between `candidate` and `existing` slots, or null. Precedence:
 * duplicate > section > teacher > room > student; ties by existing slot order.
 */
export function findSlotConflict(candidate: ConflictSlot, existing: readonly ConflictSlot[]): SlotConflict | null {
  const clashing = existing.filter(
    (e) =>
      e.id !== undefined &&
      e.dayOfWeek === candidate.dayOfWeek &&
      termsOverlap(e.termId, candidate.termId) &&
      hasTimeOverlap(e, candidate),
  );
  const base = (e: ConflictSlot) => ({
    slotId: e.id!,
    dayOfWeek: e.dayOfWeek,
    startsAt: formatTime(parseTime(e.startsAt)!),
    endsAt: formatTime(parseTime(e.endsAt)!),
    classSectionId: e.classSectionId,
  });
  const same = (x: string, y: string) => parseTime(x) === parseTime(y);
  const room = roomKey(candidate.room);

  const dup = clashing.find(
    (e) =>
      e.classSectionId === candidate.classSectionId &&
      same(e.startsAt, candidate.startsAt) &&
      same(e.endsAt, candidate.endsAt) &&
      e.teacherAssignmentId === candidate.teacherAssignmentId &&
      roomKey(e.room) === room &&
      e.termId === candidate.termId,
  );
  if (dup) return { kind: "duplicate", ...base(dup) };

  const section = clashing.find((e) => e.classSectionId === candidate.classSectionId);
  if (section) return { kind: "section", ...base(section) };

  if (candidate.teacherPersonId) {
    const t = clashing.find((e) => e.teacherPersonId === candidate.teacherPersonId);
    if (t) return { kind: "teacher", ...base(t), teacherPersonId: candidate.teacherPersonId };
  }

  if (room) {
    const r = clashing.find((e) => roomKey(e.room) === room);
    if (r) return { kind: "room", ...base(r), room: r.room!.trim() };
  }

  if (candidate.studentPersonIds.length > 0) {
    const mine = new Set(candidate.studentPersonIds);
    for (const e of clashing) {
      const shared = e.studentPersonIds.filter((s) => mine.has(s)).sort();
      if (shared.length > 0) return { kind: "student", ...base(e), studentPersonId: shared[0]! };
    }
  }
  return null;
}

// ─── Database: create ────────────────────────────────────────────────────────

export interface CreateTimetableSlotInput {
  tenantId: string;
  classSectionId: string;
  teacherAssignmentId?: string | null;
  termId?: string | null;
  room?: string | null;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  /** "HH:MM" or "HH:MM:SS", 24h. */
  startsAt: string;
  endsAt: string;
}

export interface TimetableSlotView {
  id: string;
  tenantId: string;
  classSectionId: string;
  teacherAssignmentId: string | null;
  termId: string | null;
  room: string | null;
  dayOfWeek: number;
  /** "HH:MM" */
  startsAt: string;
  endsAt: string;
}

interface ValidSlot {
  tenantId: string;
  classSectionId: string;
  teacherAssignmentId: string | null;
  termId: string | null;
  room: string | null;
  dayOfWeek: number;
  start: number;
  end: number;
}

/** Validate shape + references (tenant-scoped). Throws TimetableValidationError. */
async function validateSlot(
  db: Db,
  input: CreateTimetableSlotInput,
): Promise<{ slot: ValidSlot; academicYearId: string; teacherPersonId: string | null }> {
  const { tenantId } = input;
  if (!isValidDayOfWeek(input.dayOfWeek))
    throw new TimetableValidationError("bad_day", `day of week must be an integer 1 (Monday) … 7 (Sunday), got ${input.dayOfWeek}`);
  const start = parseTime(input.startsAt ?? "");
  const end = parseTime(input.endsAt ?? "");
  if (start === null || end === null)
    throw new TimetableValidationError("bad_time", `times must be HH:MM, got "${input.startsAt}"-"${input.endsAt}"`);
  if (start >= end)
    throw new TimetableValidationError("bad_time", `start ${formatTime(start)} must be before end ${formatTime(end)}`);

  const section = await db.classSection.findFirst({
    where: { tenantId, id: input.classSectionId },
    select: { id: true, courseId: true, course: { select: { academicYearId: true } } },
  });
  if (!section) throw new TimetableValidationError("unknown_section", `class section ${input.classSectionId} not found in tenant`);
  const academicYearId = section.course.academicYearId;

  let teacherPersonId: string | null = null;
  const teacherAssignmentId = input.teacherAssignmentId ?? null;
  if (teacherAssignmentId) {
    const ta = await db.teacherAssignment.findFirst({
      where: { tenantId, id: teacherAssignmentId },
      select: { teacherPersonId: true, courseId: true, classSectionId: true },
    });
    // The assignment must cover this section: same section, or the whole course (section NULL).
    if (!ta || ta.courseId !== section.courseId || (ta.classSectionId !== null && ta.classSectionId !== section.id))
      throw new TimetableValidationError(
        "unknown_teacher_assignment",
        `teacher assignment ${teacherAssignmentId} does not cover class section ${section.id}`,
      );
    teacherPersonId = ta.teacherPersonId;
  }

  const termId = input.termId ?? null;
  if (termId) {
    const term = await db.term.findFirst({ where: { tenantId, id: termId, academicYearId }, select: { id: true } });
    if (!term) throw new TimetableValidationError("unknown_term", `term ${termId} is not a term of the section's academic year`);
  }

  const room = input.room?.trim() || null;
  return {
    slot: { tenantId, classSectionId: section.id, teacherAssignmentId, termId, room, dayOfWeek: input.dayOfWeek, start, end },
    academicYearId,
    teacherPersonId,
  };
}

/**
 * Existing slots of the same tenant + academic year + weekday whose time range
 * overlaps [start, end), as ConflictSlots. Only enrollments of `students` are loaded.
 */
async function overlappingSlots(
  db: Db,
  slot: ValidSlot,
  academicYearId: string,
  students: readonly string[],
): Promise<ConflictSlot[]> {
  const rows = await db.timetableSlot.findMany({
    where: {
      tenantId: slot.tenantId,
      dayOfWeek: slot.dayOfWeek,
      startsAt: { lt: dateOfTime(slot.end) },
      endsAt: { gt: dateOfTime(slot.start) },
      classSection: { course: { academicYearId } },
    },
    select: {
      id: true,
      classSectionId: true,
      teacherAssignmentId: true,
      termId: true,
      room: true,
      dayOfWeek: true,
      startsAt: true,
      endsAt: true,
      teacherAssignment: { select: { teacherPersonId: true } },
      classSection: {
        select: {
          enrollments: {
            where: { status: "active", studentPersonId: { in: [...students] } },
            select: { studentPersonId: true },
          },
        },
      },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    classSectionId: r.classSectionId,
    teacherAssignmentId: r.teacherAssignmentId,
    teacherPersonId: r.teacherAssignment?.teacherPersonId ?? null,
    room: r.room,
    termId: r.termId,
    dayOfWeek: r.dayOfWeek,
    startsAt: timeOfDate(r.startsAt),
    endsAt: timeOfDate(r.endsAt),
    studentPersonIds: r.classSection.enrollments.map((e) => e.studentPersonId),
  }));
}

async function createInTx(db: Db, input: CreateTimetableSlotInput): Promise<TimetableSlotView> {
  const { slot, academicYearId, teacherPersonId } = await validateSlot(db, input);
  // Serialise timetable writes per tenant so two concurrent creates cannot both pass the check.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:timetable:${slot.tenantId}`}))`;

  const students = (
    await db.enrollment.findMany({
      where: { tenantId: slot.tenantId, classSectionId: slot.classSectionId, status: "active" },
      select: { studentPersonId: true },
    })
  ).map((e) => e.studentPersonId);

  const candidate: ConflictSlot = {
    classSectionId: slot.classSectionId,
    teacherAssignmentId: slot.teacherAssignmentId,
    teacherPersonId,
    room: slot.room,
    termId: slot.termId,
    dayOfWeek: slot.dayOfWeek,
    startsAt: formatTime(slot.start),
    endsAt: formatTime(slot.end),
    studentPersonIds: students,
  };
  const conflict = findSlotConflict(candidate, await overlappingSlots(db, slot, academicYearId, students));
  if (conflict) throw new TimetableConflictError(conflict);

  const row = await db.timetableSlot.create({
    data: {
      tenantId: slot.tenantId,
      classSectionId: slot.classSectionId,
      teacherAssignmentId: slot.teacherAssignmentId,
      termId: slot.termId,
      room: slot.room,
      dayOfWeek: slot.dayOfWeek,
      startsAt: dateOfTime(slot.start),
      endsAt: dateOfTime(slot.end),
    },
  });
  return {
    id: row.id,
    tenantId: row.tenantId,
    classSectionId: row.classSectionId,
    teacherAssignmentId: row.teacherAssignmentId,
    termId: row.termId,
    room: row.room,
    dayOfWeek: row.dayOfWeek,
    startsAt: timeOfDate(row.startsAt),
    endsAt: timeOfDate(row.endsAt),
  };
}

/**
 * Create one timetable slot, or throw `TimetableValidationError` (bad input /
 * unknown reference) or `TimetableConflictError` (double-booking). Writes nothing
 * when it throws.
 *
 * `db` must be an OWNER-role client or transaction. Given a PrismaClient the
 * check-and-insert runs in its own transaction.
 */
export async function createTimetableSlot(
  db: PrismaClient | Db,
  input: CreateTimetableSlotInput,
): Promise<TimetableSlotView> {
  if (typeof (db as Partial<PrismaClient>).$transaction === "function")
    return (db as PrismaClient).$transaction((tx) => createInTx(tx, input), { timeout: 60_000 });
  return createInTx(db as Db, input);
}

// ─── Database: grid queries ──────────────────────────────────────────────────

export interface TimetableGridSlot extends TimetableSlotView {
  sectionCode: string;
  sectionName: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  teacherPersonId: string | null;
}

export interface GridQueryOptions {
  /** Only slots for this term (plus all-year slots, termId NULL). Default: every slot. */
  termId?: string;
  /** Only sections of this academic year. Default: every year. */
  academicYearId?: string;
}

const GRID_SELECT = {
  id: true,
  tenantId: true,
  classSectionId: true,
  teacherAssignmentId: true,
  termId: true,
  room: true,
  dayOfWeek: true,
  startsAt: true,
  endsAt: true,
  teacherAssignment: { select: { teacherPersonId: true } },
  classSection: { select: { code: true, name: true, course: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.TimetableSlotSelect;

async function grid(
  db: Db | PrismaClient,
  tenantId: string,
  where: Prisma.TimetableSlotWhereInput,
  opts: GridQueryOptions,
): Promise<TimetableGridSlot[]> {
  const and: Prisma.TimetableSlotWhereInput[] = [{ tenantId }, where];
  if (opts.termId) and.push({ OR: [{ termId: null }, { termId: opts.termId }] });
  if (opts.academicYearId) and.push({ classSection: { course: { academicYearId: opts.academicYearId } } });
  const rows = await db.timetableSlot.findMany({
    where: { AND: and },
    select: GRID_SELECT,
    orderBy: [{ dayOfWeek: "asc" }, { startsAt: "asc" }, { endsAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    classSectionId: r.classSectionId,
    teacherAssignmentId: r.teacherAssignmentId,
    termId: r.termId,
    room: r.room,
    dayOfWeek: r.dayOfWeek,
    startsAt: timeOfDate(r.startsAt),
    endsAt: timeOfDate(r.endsAt),
    sectionCode: r.classSection.code,
    sectionName: r.classSection.name,
    courseId: r.classSection.course.id,
    courseCode: r.classSection.course.code,
    courseName: r.classSection.course.name,
    teacherPersonId: r.teacherAssignment?.teacherPersonId ?? null,
  }));
}

/** A student's weekly grid: slots of every section they are actively enrolled in. */
export function listTimetableForStudent(
  db: Db | PrismaClient,
  args: { tenantId: string; studentPersonId: string } & GridQueryOptions,
): Promise<TimetableGridSlot[]> {
  return grid(
    db,
    args.tenantId,
    { classSection: { enrollments: { some: { tenantId: args.tenantId, studentPersonId: args.studentPersonId, status: "active" } } } },
    args,
  );
}

/** A teacher's weekly grid: slots whose teacher assignment belongs to the teacher. */
export function listTimetableForTeacher(
  db: Db | PrismaClient,
  args: { tenantId: string; teacherPersonId: string } & GridQueryOptions,
): Promise<TimetableGridSlot[]> {
  return grid(db, args.tenantId, { teacherAssignment: { teacherPersonId: args.teacherPersonId } }, args);
}

/** A room's weekly grid (room match is trimmed and case-insensitive). */
export function listTimetableForRoom(
  db: Db | PrismaClient,
  args: { tenantId: string; room: string } & GridQueryOptions,
): Promise<TimetableGridSlot[]> {
  const room = args.room.trim();
  if (!room) return Promise.resolve([]);
  return grid(db, args.tenantId, { room: { equals: room, mode: "insensitive" } }, args);
}
