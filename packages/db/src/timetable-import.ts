/**
 * Timetable CSV import (slice 3a).
 *
 * `parseCsv` is a minimal RFC 4180 parser (quotes, "" escapes, CRLF, BOM; no deps).
 * `importTimetableCsv` resolves each row against the tenant's academic year, inserts
 * it through `createTimetableSlot` (so every conflict rule applies, including against
 * rows earlier in the same file) and returns a per-row report. Rejected rows write
 * nothing; accepted rows are committed together at the end (one owner transaction).
 *
 * Columns (header row required, names case-insensitive, any order):
 *   day      required  ISO weekday 1-7 (1 = Monday) or an English day name / 3-letter abbreviation
 *   start    required  HH:MM (24h)
 *   end      required  HH:MM (24h), after start
 *   course   required  course code in the academic year (e.g. MATH-10)
 *   section  required  class-section code within that course (e.g. 10-A)
 *   teacher  optional  staff external ref (person.external_ref) of a teacher assigned to the section
 *   room     optional  free text; checked against `rooms` when that allow-list is given
 *   term     optional  term key in the academic year (e.g. term-1); empty = every term
 *
 * Re-importing the same file rejects every row as `duplicate`; nothing is inserted twice.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  createTimetableSlot,
  roomKey,
  TimetableConflictError,
  TimetableValidationError,
  type SlotConflict,
  type TimetableValidationCode,
} from "./timetable";

type Db = Prisma.TransactionClient;

// ─── CSV ─────────────────────────────────────────────────────────────────────

export interface CsvRecord {
  /** 1-based physical line where the record starts. */
  line: number;
  fields: string[];
}
export interface CsvParseResult {
  records: CsvRecord[];
  /** Lines with an unterminated quote or stray characters after a closing quote. */
  errors: { line: number; message: string }[];
}

/** Minimal RFC 4180 parser. Blank lines are skipped. */
export function parseCsv(text: string): CsvParseResult {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  const errors: CsvParseResult["errors"] = [];
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const startLine = line;
    const fields: string[] = [];
    let field = "";
    let bad: string | null = null;
    let endOfRecord = false;
    while (!endOfRecord) {
      if (src[i] === '"') {
        // Quoted field.
        i++;
        let closed = false;
        while (i < src.length) {
          const c = src[i]!;
          if (c === '"') {
            if (src[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (c === "\n") line++;
          field += c;
          i++;
        }
        if (!closed) bad ??= "unterminated quoted field";
        // Only a delimiter or end of line may follow a closing quote.
        while (i < src.length && src[i] !== "," && src[i] !== "\n" && src[i] !== "\r") {
          bad ??= "unexpected character after closing quote";
          i++;
        }
      } else {
        while (i < src.length && src[i] !== "," && src[i] !== "\n" && src[i] !== "\r") field += src[i++];
      }
      fields.push(field);
      field = "";
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "\r") i++;
      if (src[i] === "\n") {
        i++;
        line++;
      }
      endOfRecord = true;
    }
    if (bad) errors.push({ line: startLine, message: bad });
    else if (!(fields.length === 1 && fields[0]!.trim() === "")) records.push({ line: startLine, fields });
  }
  return { records, errors };
}

// ─── Import ──────────────────────────────────────────────────────────────────

export const TIMETABLE_CSV_COLUMNS = ["day", "start", "end", "course", "section", "teacher", "room", "term"] as const;
export const TIMETABLE_CSV_REQUIRED = ["day", "start", "end", "course", "section"] as const;
type Column = (typeof TIMETABLE_CSV_COLUMNS)[number];

export type ImportRejectReason =
  | "malformed_row"
  | "bad_day"
  | "bad_time"
  | "unknown_section"
  | "unknown_teacher"
  | "unknown_room"
  | "unknown_term"
  | "duplicate"
  | "conflict";

export interface ImportAcceptedRow {
  line: number;
  slotId: string;
  values: Record<Column, string>;
}
export interface ImportRejectedRow {
  line: number;
  reason: ImportRejectReason;
  message: string;
  /** Set for reason = conflict | duplicate. */
  conflict?: SlotConflict;
  values?: Record<Column, string>;
}
export interface TimetableImportReport {
  academicYearId: string;
  /** Data records seen (header and blank lines excluded, malformed included). */
  totalRows: number;
  accepted: ImportAcceptedRow[];
  rejected: ImportRejectedRow[];
}

export interface TimetableImportOptions {
  tenantId: string;
  /** Default: the tenant's current academic year (is_current). */
  academicYearId?: string;
  /** Optional room allow-list (trimmed, case-insensitive). When omitted any room is accepted. */
  rooms?: readonly string[];
}

/** Whole-file problems (missing header columns, no academic year). */
export class TimetableImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimetableImportError";
  }
}

const DAY_NAMES: Record<string, number> = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};

/** "1".."7" or an English day name -> ISO weekday; null if unknown. */
export function parseDayOfWeek(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (/^[1-7]$/.test(v)) return Number(v);
  return DAY_NAMES[v] ?? null;
}

const VALIDATION_REASON: Record<TimetableValidationCode, ImportRejectReason> = {
  bad_day: "bad_day",
  bad_time: "bad_time",
  unknown_section: "unknown_section",
  unknown_teacher_assignment: "unknown_teacher",
  unknown_term: "unknown_term",
};

async function importInTx(db: Db, csv: string, opts: TimetableImportOptions): Promise<TimetableImportReport> {
  const { tenantId } = opts;
  const year = opts.academicYearId
    ? await db.academicYear.findFirst({ where: { tenantId, id: opts.academicYearId }, select: { id: true } })
    : await db.academicYear.findFirst({ where: { tenantId, isCurrent: true }, select: { id: true } });
  if (!year) throw new TimetableImportError(`no ${opts.academicYearId ? "such" : "current"} academic year for tenant ${tenantId}`);
  const academicYearId = year.id;

  const { records, errors } = parseCsv(csv);
  const [header, ...rows] = records;
  if (!header) throw new TimetableImportError("empty CSV: a header row is required");
  if (errors.some((e) => e.line === header.line)) throw new TimetableImportError(`malformed header row`);
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const missing = TIMETABLE_CSV_REQUIRED.filter((c) => !names.includes(c));
  if (missing.length > 0) throw new TimetableImportError(`missing required column(s): ${missing.join(", ")}`);
  const index = Object.fromEntries(TIMETABLE_CSV_COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<Column, number>;

  // Lookups for the year, loaded once.
  const sections = await db.classSection.findMany({
    where: { tenantId, course: { academicYearId } },
    select: { id: true, code: true, courseId: true, course: { select: { code: true } } },
  });
  const sectionByKey = new Map(sections.map((s) => [`${s.course.code.toLowerCase()}|${s.code.toLowerCase()}`, s]));
  const terms = await db.term.findMany({ where: { tenantId, academicYearId }, select: { id: true, key: true } });
  const termByKey = new Map(terms.map((t) => [t.key.toLowerCase(), t.id]));
  const assignments = await db.teacherAssignment.findMany({
    where: { tenantId, course: { academicYearId } },
    select: { id: true, courseId: true, classSectionId: true, role: true, teacher: { select: { externalRef: true } } },
    orderBy: [{ role: "asc" }, { id: "asc" }],
  });
  const knownTeacherRefs = new Set(
    (await db.person.findMany({ where: { tenantId, externalRef: { not: null } }, select: { externalRef: true } })).map((p) =>
      p.externalRef!.toLowerCase(),
    ),
  );
  const allowedRooms = opts.rooms ? new Set(opts.rooms.map(roomKey).filter((r): r is string => r !== null)) : null;

  const report: TimetableImportReport = {
    academicYearId,
    totalRows: rows.length + errors.filter((e) => e.line !== header.line).length,
    accepted: [],
    rejected: [],
  };
  for (const e of errors) if (e.line !== header.line) report.rejected.push({ line: e.line, reason: "malformed_row", message: e.message });

  for (const rec of rows) {
    const reject = (reason: ImportRejectReason, message: string, extra: Partial<ImportRejectedRow> = {}) =>
      report.rejected.push({ line: rec.line, reason, message, ...extra });
    if (rec.fields.length !== header.fields.length) {
      reject("malformed_row", `expected ${header.fields.length} fields, got ${rec.fields.length}`);
      continue;
    }
    const values = Object.fromEntries(
      TIMETABLE_CSV_COLUMNS.map((c) => [c, index[c] >= 0 ? rec.fields[index[c]]!.trim() : ""]),
    ) as Record<Column, string>;
    const fail = (reason: ImportRejectReason, message: string, extra: Partial<ImportRejectedRow> = {}) =>
      reject(reason, message, { values, ...extra });

    const day = parseDayOfWeek(values.day);
    if (day === null) {
      fail("bad_day", `day must be 1-7 (1 = Monday) or a day name, got "${values.day}"`);
      continue;
    }
    if (!values.start || !values.end) {
      fail("bad_time", "start and end are required");
      continue;
    }
    if (!values.course || !values.section) {
      fail("unknown_section", "course and section are required");
      continue;
    }
    const section = sectionByKey.get(`${values.course.toLowerCase()}|${values.section.toLowerCase()}`);
    if (!section) {
      fail("unknown_section", `no section "${values.section}" in course "${values.course}" this academic year`);
      continue;
    }
    let teacherAssignmentId: string | null = null;
    if (values.teacher) {
      const ref = values.teacher.toLowerCase();
      if (!knownTeacherRefs.has(ref)) {
        fail("unknown_teacher", `no staff member with external ref "${values.teacher}"`);
        continue;
      }
      const ta = assignments.find(
        (a) =>
          a.teacher.externalRef?.toLowerCase() === ref &&
          a.courseId === section.courseId &&
          (a.classSectionId === null || a.classSectionId === section.id),
      );
      if (!ta) {
        fail("unknown_teacher", `"${values.teacher}" is not assigned to ${values.course} / ${values.section}`);
        continue;
      }
      teacherAssignmentId = ta.id;
    }
    if (values.room && allowedRooms && !allowedRooms.has(roomKey(values.room)!)) {
      fail("unknown_room", `room "${values.room}" is not in the school's room list`);
      continue;
    }
    let termId: string | null = null;
    if (values.term) {
      termId = termByKey.get(values.term.toLowerCase()) ?? null;
      if (!termId) {
        fail("unknown_term", `no term "${values.term}" in this academic year`);
        continue;
      }
    }

    try {
      const slot = await createTimetableSlot(db, {
        tenantId,
        classSectionId: section.id,
        teacherAssignmentId,
        termId,
        room: values.room || null,
        dayOfWeek: day,
        startsAt: values.start,
        endsAt: values.end,
      });
      report.accepted.push({ line: rec.line, slotId: slot.id, values });
    } catch (e) {
      if (e instanceof TimetableConflictError) {
        const dup = e.conflict.kind === "duplicate";
        fail(dup ? "duplicate" : "conflict", dup ? `identical slot already exists (${e.conflict.slotId})` : e.message, {
          conflict: e.conflict,
        });
      } else if (e instanceof TimetableValidationError) {
        fail(VALIDATION_REASON[e.code], e.message);
      } else throw e;
    }
  }
  report.rejected.sort((a, b) => a.line - b.line);
  return report;
}

/**
 * Import timetable slots from CSV for one tenant. Returns a report of accepted
 * (inserted) and rejected rows; throws `TimetableImportError` for whole-file problems.
 *
 * `db` must be an OWNER-role client or transaction. Given a PrismaClient the whole
 * import runs in one transaction (accepted rows commit together).
 */
export async function importTimetableCsv(
  db: PrismaClient | Db,
  csv: string,
  opts: TimetableImportOptions,
): Promise<TimetableImportReport> {
  if (typeof (db as Partial<PrismaClient>).$transaction === "function")
    return (db as PrismaClient).$transaction((tx) => importInTx(tx, csv, opts), { timeout: 300_000 });
  return importInTx(db as Db, csv, opts);
}
