/**
 * Attendance service (slice 3b): pure helpers, recordAttendance, grid, QR, list queries.
 *
 * Database cases run as the owner inside a transaction that is rolled back, so the
 * shared database is left exactly as seeded. The RLS case commits a few rows (through
 * the service), reads them through the app role and deletes them again.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttendanceError,
  attendanceRate,
  issueAttendanceQr,
  listAttendanceForSection,
  listAttendanceForStudent,
  markAttendanceFromGrid,
  markAttendanceFromQr,
  parseAttendanceDate,
  recordAttendance,
  signAttendanceToken,
  verifyAttendanceToken,
  type AttendanceErrorCode,
} from "../src/attendance";
import { createTimetableSlot } from "../src/timetable";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const NIL = "00000000-0000-4000-8000-000000000000";

async function rejects(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}
async function expectCode(p: Promise<unknown> | (() => unknown), code: AttendanceErrorCode) {
  const e = await rejects(p);
  expect(e).toBeInstanceOf(AttendanceError);
  expect((e as AttendanceError).code).toBe(code);
}

// ─── Pure ────────────────────────────────────────────────────────────────────

describe("attendance: pure helpers", () => {
  it("parseAttendanceDate accepts real calendar days only", () => {
    expect(parseAttendanceDate("2026-10-05")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    for (const bad of ["", "2026-02-30", "2026-13-01", "05/10/2026", "2026-1-5", "2026-10-05T00:00"])
      expect(parseAttendanceDate(bad)).toBeNull();
  });

  it("attendanceRate: late counts as attended, excused stays in the denominator", () => {
    expect(attendanceRate({ present: 6, late: 2, absent: 1, excused: 1 })).toBe(80);
    expect(attendanceRate({ present: 1, late: 1, absent: 0, excused: 1 })).toBe(66.67);
    expect(attendanceRate({ present: 0, late: 0, absent: 0, excused: 0 })).toBeNull();
  });

  it("QR tokens: round-trip, tamper, wrong key, expiry", () => {
    const payload = { tenantId: TENANT_A, slotId: NIL, date: "2026-10-05", expiresAt: 1_000_000 };
    const token = signAttendanceToken(payload, KEY);
    expect(verifyAttendanceToken(token, KEY, 999_999)).toEqual(payload);
    expect(() => verifyAttendanceToken(token, KEY, 1_000_000)).toThrow(/expired/);
    expect(() => verifyAttendanceToken(token, OTHER_KEY, 0)).toThrow(/signature/);
    // Swap the payload for another tenant's but keep the signature.
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...payload, tenantId: TENANT_B })).toString("base64url")}.${sig}`;
    expect(() => verifyAttendanceToken(forged, KEY, 0)).toThrow(AttendanceError);
    for (const bad of ["", "abc", "a.b.c", `${token}x`]) expect(() => verifyAttendanceToken(bad, KEY, 0)).toThrow(AttendanceError);
  });
});

// ─── Database ────────────────────────────────────────────────────────────────

let app: PrismaClient;
let owner: PrismaClient;

beforeAll(() => {
  app = appClient();
  owner = ownerClient();
});
afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

async function ownerRolledBack<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await owner
    .$transaction(
      async (tx) => {
        out = await fn(tx);
        throw new Rollback();
      },
      { timeout: 180_000, maxWait: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

interface Sec {
  id: string;
  taId: string;
  teacherPersonId: string;
  /** Active enrollments, by student id. */
  enrollments: { id: string; studentPersonId: string }[];
}
async function section(db: Prisma.TransactionClient | PrismaClient, tenantId: string, courseCode: string): Promise<Sec> {
  const s = await db.classSection.findFirstOrThrow({
    where: { tenantId, course: { code: courseCode } },
    select: {
      id: true,
      teacherAssignments: { select: { id: true, teacherPersonId: true } },
      enrollments: { where: { status: "active" }, select: { id: true, studentPersonId: true }, orderBy: { studentPersonId: "asc" } },
    },
  });
  return {
    id: s.id,
    taId: s.teacherAssignments[0]!.id,
    teacherPersonId: s.teacherAssignments[0]!.teacherPersonId,
    enrollments: s.enrollments,
  };
}

// Tenant A (Albania) year 2026-09-14..2027-06-18; period-1 ends 2027-01-30.
const DAY = "2026-10-05"; // a Monday inside period-1
const slotOn = (tx: Prisma.TransactionClient, s: Sec, termId: string | null = null) =>
  createTimetableSlot(tx, { tenantId: TENANT_A, classSectionId: s.id, teacherAssignmentId: s.taId, termId, dayOfWeek: 1, startsAt: "08:00", endsAt: "08:45" });

describe("attendance: recordAttendance (owner, rolled back)", () => {
  it(
    "golden: records one mark and exactly one attendance.recorded Event with the right actor/subject/payload",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const slot = await slotOn(tx, math10);
        const e0 = math10.enrollments[0]!;
        const before = await tx.event.count({ where: { tenantId: TENANT_A } });

        const rec = await recordAttendance(tx, {
          tenantId: TENANT_A,
          enrollmentId: e0.id,
          studentPersonId: e0.studentPersonId,
          timetableSlotId: slot.id,
          date: DAY,
          status: "late",
          recordedByPersonId: math10.teacherPersonId,
          comment: "  bus  ",
        });
        expect(rec).toMatchObject({
          enrollmentId: e0.id,
          studentPersonId: e0.studentPersonId,
          classSectionId: math10.id,
          timetableSlotId: slot.id,
          date: DAY,
          status: "late",
          method: "grid",
          recordedByPersonId: math10.teacherPersonId,
          comment: "bus",
        });
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + 1);
        const events = await tx.event.findMany({ where: { tenantId: TENANT_A, entityId: rec.id } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "attendance.recorded",
          actorPersonId: math10.teacherPersonId,
          subjectPersonId: e0.studentPersonId,
          entityType: "attendance_event",
          entityId: rec.id,
          payload: { status: "late", method: "grid", date: DAY, slotId: slot.id },
        });

        // Whole-day mark (no slot) for the same day is a different mark; payload has no slotId.
        const day = await recordAttendance(tx, { tenantId: TENANT_A, enrollmentId: e0.id, studentPersonId: e0.studentPersonId, date: DAY, status: "present" });
        const dayEvent = await tx.event.findFirstOrThrow({ where: { entityId: day.id } });
        expect(dayEvent.payload).toEqual({ status: "present", method: "grid", date: DAY });
        expect(dayEvent.actorPersonId).toBeNull();
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + 2);
      });
    },
    120_000,
  );

  it(
    "validation: unknown / foreign enrollment, student mismatch, foreign slot, slot of another section, out-of-range dates, duplicates",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const lang11 = await section(tx, TENANT_A, "LANG-11");
        const foreign = await section(tx, TENANT_B, "MATH-10");
        const [t1, t2] = await tx.term.findMany({ where: { tenantId: TENANT_A }, orderBy: { sequence: "asc" } });
        const slot = await slotOn(tx, math10, t1!.id);
        const otherSectionSlot = await slotOn(tx, lang11, t2!.id);
        const foreignSlot = await createTimetableSlot(tx, { tenantId: TENANT_B, classSectionId: foreign.id, dayOfWeek: 1, startsAt: "08:00", endsAt: "08:45" });
        const e0 = math10.enrollments[0]!;
        const e1 = math10.enrollments[1]!;
        const base = { tenantId: TENANT_A, enrollmentId: e0.id, studentPersonId: e0.studentPersonId, date: DAY, status: "present" as const };
        const eventsBefore = await tx.event.count();

        await expectCode(recordAttendance(tx, { ...base, enrollmentId: NIL }), "unknown_enrollment");
        await expectCode(recordAttendance(tx, { ...base, enrollmentId: foreign.enrollments[0]!.id }), "unknown_enrollment");
        await expectCode(recordAttendance(tx, { ...base, studentPersonId: e1.studentPersonId }), "student_mismatch");
        await expectCode(recordAttendance(tx, { ...base, timetableSlotId: foreignSlot.id }), "unknown_slot");
        await expectCode(recordAttendance(tx, { ...base, timetableSlotId: otherSectionSlot.id }), "slot_section_mismatch");
        // Slot is for term 1: a date in term 2 is out of range even though it is inside the year.
        await expectCode(recordAttendance(tx, { ...base, timetableSlotId: slot.id, date: "2027-03-01" }), "out_of_range");
        // No slot: bounded by the academic year.
        await expectCode(recordAttendance(tx, { ...base, date: "2026-09-13" }), "out_of_range");
        await expectCode(recordAttendance(tx, { ...base, date: "2027-06-19" }), "out_of_range");
        await expectCode(recordAttendance(tx, { ...base, date: "2026-02-30" }), "bad_date");
        await expectCode(recordAttendance(tx, { ...base, status: "sleeping" as never }), "bad_status");
        expect(await tx.attendanceEvent.count({ where: { tenantId: TENANT_A } })).toBe(0);
        expect(await tx.event.count()).toBe(eventsBefore);

        // Edges of the range are accepted; a repeat of the same mark is a duplicate (with and without a slot).
        await recordAttendance(tx, { ...base, date: "2026-09-14" });
        await recordAttendance(tx, { ...base, timetableSlotId: slot.id, date: "2027-01-30" });
        await expectCode(recordAttendance(tx, { ...base, date: "2026-09-14", status: "absent" }), "duplicate");
        await expectCode(recordAttendance(tx, { ...base, timetableSlotId: slot.id, date: "2027-01-30" }), "duplicate");
        expect(await tx.attendanceEvent.count({ where: { tenantId: TENANT_A } })).toBe(2);
        expect(await tx.event.count()).toBe(eventsBefore + 2);
      });
    },
    120_000,
  );
});

describe("attendance: markAttendanceFromGrid", () => {
  it(
    "batch: one mark + one Event per row, method grid, in input order",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const slot = await slotOn(tx, math10);
        expect(math10.enrollments.length).toBeGreaterThanOrEqual(3);
        const statuses = ["present", "late", "absent", "excused"] as const;
        const rows = math10.enrollments.map((e, i) => ({ studentPersonId: e.studentPersonId, status: statuses[i % 4]!, comment: i === 2 ? "sick" : undefined }));
        const before = await tx.event.count({ where: { tenantId: TENANT_A } });
        const out = await markAttendanceFromGrid(tx, math10.id, DAY, rows, { tenantId: TENANT_A, timetableSlotId: slot.id, recordedByPersonId: math10.teacherPersonId });
        expect(out.map((o) => [o.studentPersonId, o.status, o.method])).toEqual(rows.map((r) => [r.studentPersonId, r.status, "grid"]));
        expect(out[2]!.comment).toBe("sick");
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + rows.length);
        const evs = await tx.event.findMany({ where: { tenantId: TENANT_A, type: "attendance.recorded", entityId: { in: out.map((o) => o.id) } } });
        expect(evs).toHaveLength(rows.length);
        for (const ev of evs) expect(ev.actorPersonId).toBe(math10.teacherPersonId);
      });
    },
    120_000,
  );

  it(
    "all-or-nothing: a non-enrolled, withdrawn, repeated or already-marked student commits nothing",
    async () => {
      const math10 = await section(owner, TENANT_A, "MATH-10");
      const math11 = await section(owner, TENANT_A, "MATH-11");
      const good = math10.enrollments.slice(0, 2).map((e) => ({ studentPersonId: e.studentPersonId, status: "present" as const }));
      const outsider = math11.enrollments.find((e) => !math10.enrollments.some((m) => m.studentPersonId === e.studentPersonId))!;
      const counts = async () => ({
        att: await owner.attendanceEvent.count({ where: { tenantId: TENANT_A } }),
        ev: await owner.event.count({ where: { tenantId: TENANT_A } }),
      });
      const before = await counts();
      // Own transaction per call (PrismaClient): the failing row is LAST, after valid rows.
      await expectCode(
        markAttendanceFromGrid(owner, math10.id, DAY, [...good, { studentPersonId: outsider.studentPersonId, status: "absent" }], { tenantId: TENANT_A }),
        "not_enrolled",
      );
      await expectCode(markAttendanceFromGrid(owner, math10.id, DAY, [...good, good[0]!], { tenantId: TENANT_A }), "duplicate");
      await expectCode(markAttendanceFromGrid(owner, math10.id, DAY, good, { tenantId: TENANT_B }), "unknown_section");
      expect(await counts()).toEqual(before);

      // Withdrawn enrollment + a mark that already exists (detected only at insert time, mid-batch).
      await ownerRolledBack(async (tx) => {
        const last = math10.enrollments[math10.enrollments.length - 1]!;
        await tx.enrollment.update({ where: { id: last.id }, data: { status: "withdrawn" } });
        await expectCode(
          markAttendanceFromGrid(tx, math10.id, DAY, [...good, { studentPersonId: last.studentPersonId, status: "present" }], { tenantId: TENANT_A }),
          "not_enrolled",
        );
      });
      const second = math10.enrollments[1]!;
      const pre = await recordAttendance(owner, { tenantId: TENANT_A, enrollmentId: second.id, studentPersonId: second.studentPersonId, date: DAY, status: "present" });
      try {
        await expectCode(markAttendanceFromGrid(owner, math10.id, DAY, good, { tenantId: TENANT_A }), "duplicate");
        // Only the pre-existing mark (and its event) exist: row 1 of the failed batch rolled back.
        expect(await counts()).toEqual({ att: before.att + 1, ev: before.ev + 1 });
      } finally {
        await owner.event.deleteMany({ where: { tenantId: TENANT_A, entityId: pre.id } });
        await owner.attendanceEvent.delete({ where: { id: pre.id } });
      }
      expect(await counts()).toEqual(before);
    },
    180_000,
  );
});

describe("attendance: QR", () => {
  it(
    "issue + scan: valid, expired, tampered, foreign tenant, not enrolled, duplicate",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const math11 = await section(tx, TENANT_A, "MATH-11");
        const slot = await slotOn(tx, math10);
        const now = Date.UTC(2026, 9, 5, 8, 5);
        const { token, expiresAt, payload } = await issueAttendanceQr(tx, slot.id, DAY, { tenantId: TENANT_A, key: KEY, now, expiresInMinutes: 10 });
        expect(payload).toEqual({ tenantId: TENANT_A, slotId: slot.id, date: DAY, expiresAt: now + 600_000 });
        expect(expiresAt.getTime()).toBe(now + 600_000);

        const s0 = math10.enrollments[0]!;
        const before = await tx.event.count({ where: { tenantId: TENANT_A } });
        const rec = await markAttendanceFromQr(tx, token, s0.studentPersonId, { key: KEY, now: now + 60_000, tenantId: TENANT_A });
        expect(rec).toMatchObject({ studentPersonId: s0.studentPersonId, enrollmentId: s0.id, timetableSlotId: slot.id, date: DAY, status: "present", method: "qr" });
        const ev = await tx.event.findMany({ where: { tenantId: TENANT_A, entityId: rec.id } });
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ type: "attendance.recorded", subjectPersonId: s0.studentPersonId, actorPersonId: s0.studentPersonId, payload: { status: "present", method: "qr", date: DAY, slotId: slot.id } });
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + 1);

        const s1 = math10.enrollments[1]!.studentPersonId;
        await expectCode(markAttendanceFromQr(tx, token, s0.studentPersonId, { key: KEY, now: now + 60_000 }), "duplicate");
        await expectCode(markAttendanceFromQr(tx, token, s1, { key: KEY, now: now + 600_000 }), "expired_token");
        await expectCode(markAttendanceFromQr(tx, token, s1, { key: OTHER_KEY, now }), "invalid_token");
        const [body, sig] = token.split(".") as [string, string];
        const tampered = `${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
        await expectCode(markAttendanceFromQr(tx, tampered, s1, { key: KEY, now }), "invalid_token");
        await expectCode(markAttendanceFromQr(tx, token, s1, { key: KEY, now, tenantId: TENANT_B }), "invalid_token");
        const outsider = math11.enrollments.find((e) => !math10.enrollments.some((m) => m.studentPersonId === e.studentPersonId))!;
        await expectCode(markAttendanceFromQr(tx, token, outsider.studentPersonId, { key: KEY, now }), "not_enrolled");

        // Issuing validates the slot (tenant) and the date range.
        await expectCode(issueAttendanceQr(tx, slot.id, DAY, { tenantId: TENANT_B, key: KEY }), "unknown_slot");
        await expectCode(issueAttendanceQr(tx, slot.id, "2027-07-01", { tenantId: TENANT_A, key: KEY }), "out_of_range");
        expect(await tx.attendanceEvent.count({ where: { tenantId: TENANT_A } })).toBe(1);
      });
    },
    120_000,
  );

  it("the default key is derived from SUPABASE_SECRET_KEY (no hardcoded secret)", async () => {
    expect(process.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY must be set for QR signing").toBeTruthy();
    const { attendanceQrKey } = await import("../src/attendance");
    const k1 = attendanceQrKey({ SUPABASE_SECRET_KEY: "a" });
    expect(k1).toHaveLength(32);
    expect(k1.equals(attendanceQrKey({ SUPABASE_SECRET_KEY: "b" }))).toBe(false);
    expect(() => attendanceQrKey({})).toThrow(/SUPABASE_SECRET_KEY/);
  });
});

describe("attendance: list queries", () => {
  it(
    "section / student lists are ordered by date, honour [from, to], and are tenant-isolated through the app role",
    async () => {
      const math10 = await section(owner, TENANT_A, "MATH-10");
      const eng10 = await section(owner, TENANT_A, "ENG-10");
      const b10 = await section(owner, TENANT_B, "MATH-10");
      const s0 = math10.enrollments[0]!;
      const sLang = eng10.enrollments.find((e) => e.studentPersonId === s0.studentPersonId)!;
      expect(sLang).toBeDefined();
      const created: string[] = [];
      const mark = async (tenantId: string, e: { id: string; studentPersonId: string }, date: string, status: "present" | "absent") =>
        created.push((await recordAttendance(owner, { tenantId, enrollmentId: e.id, studentPersonId: e.studentPersonId, date, status })).id);
      try {
        // Out of order on purpose.
        await mark(TENANT_A, s0, "2026-10-07", "absent");
        await mark(TENANT_A, s0, "2026-10-05", "present");
        await mark(TENANT_A, sLang, "2026-10-06", "present");
        await mark(TENANT_A, math10.enrollments[1]!, "2026-10-05", "present");
        await mark(TENANT_B, b10.enrollments[0]!, "2026-10-05", "present");

        const asA = await withTenant(
          TENANT_A,
          async (tx) => ({
            section: await listAttendanceForSection(tx, { tenantId: TENANT_A, sectionId: math10.id }),
            ranged: await listAttendanceForSection(tx, { tenantId: TENANT_A, sectionId: math10.id, from: "2026-10-06", to: "2026-10-31" }),
            student: await listAttendanceForStudent(tx, { tenantId: TENANT_A, studentPersonId: s0.studentPersonId }),
            foreignArg: await listAttendanceForSection(tx, { tenantId: TENANT_B, sectionId: b10.id }),
            scan: await tx.attendanceEvent.count(),
          }),
          { client: app },
        );
        expect(asA.section.map((r) => r.date)).toEqual(["2026-10-05", "2026-10-05", "2026-10-07"]);
        expect(asA.section.every((r) => r.classSectionId === math10.id)).toBe(true);
        expect(asA.ranged.map((r) => [r.date, r.status])).toEqual([["2026-10-07", "absent"]]);
        expect(asA.student.map((r) => [r.date, r.classSectionId])).toEqual([
          ["2026-10-05", math10.id],
          ["2026-10-06", eng10.id],
          ["2026-10-07", math10.id],
        ]);
        expect(asA.foreignArg).toEqual([]);
        expect(asA.scan).toBe(4);

        const asB = await withTenant(
          TENANT_B,
          async (tx) => ({
            byTenantA: await listAttendanceForStudent(tx, { tenantId: TENANT_A, studentPersonId: s0.studentPersonId }),
            own: await listAttendanceForSection(tx, { tenantId: TENANT_B, sectionId: b10.id }),
          }),
          { client: app },
        );
        expect(asB.byTenantA).toEqual([]);
        expect(asB.own.map((r) => r.tenantId)).toEqual([TENANT_B]);
        await expectCode(listAttendanceForSection(owner, { tenantId: TENANT_A, sectionId: math10.id, from: "2026-10-08", to: "2026-10-01" }), "bad_range");
      } finally {
        await owner.event.deleteMany({ where: { entityId: { in: created } } });
        await owner.attendanceEvent.deleteMany({ where: { id: { in: created } } });
      }
      expect(await owner.attendanceEvent.count()).toBe(0);
    },
    180_000,
  );
});
