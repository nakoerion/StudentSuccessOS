/**
 * Timetable CSV import (slice 3a): the parser (pure) and the import report (owner,
 * rolled back — the shared database is left exactly as seeded).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  importTimetableCsv,
  parseCsv,
  parseDayOfWeek,
  TimetableImportError,
  type TimetableImportReport,
} from "../src/timetable-import";
import { ownerClient, Rollback, TENANT_A } from "./helpers";

describe("timetable import: CSV parser", () => {
  it("parses quotes, escaped quotes, embedded commas/newlines, CRLF, BOM and skips blank lines", () => {
    const r = parseCsv('\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"multi\nline",\n');
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([
      { line: 1, fields: ["a", "b", "c"] },
      { line: 2, fields: ["1", "x, y", 'say "hi"'] },
      { line: 4, fields: ["2", "multi\nline", ""] },
    ]);
  });

  it("reports an unterminated quote and junk after a closing quote", () => {
    expect(parseCsv('a,b\n"ok"x,1\n').errors).toEqual([{ line: 2, message: "unexpected character after closing quote" }]);
    expect(parseCsv('a,b\n1,"open\n').errors).toEqual([{ line: 2, message: "unterminated quoted field" }]);
  });

  it("parseDayOfWeek: 1-7 and English day names", () => {
    expect(["1", "7", "Mon", "monday", " TUE ", "thurs", "Sun"].map(parseDayOfWeek)).toEqual([1, 7, 1, 1, 2, 4, 7]);
    for (const bad of ["0", "8", "", "lunedi", "1.5"]) expect(parseDayOfWeek(bad)).toBeNull();
  });
});

let owner: PrismaClient;
beforeAll(() => {
  owner = ownerClient();
});
afterAll(async () => {
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
      { timeout: 240_000, maxWait: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

/** Codes the seed gives tenant A: section code of a course + external ref of its teacher. */
async function codes(tx: Prisma.TransactionClient, courseCode: string) {
  const s = await tx.classSection.findFirstOrThrow({
    where: { tenantId: TENANT_A, course: { code: courseCode } },
    select: { code: true, teacherAssignments: { select: { teacher: { select: { externalRef: true } } } } },
  });
  return { section: s.code, teacher: s.teacherAssignments[0]!.teacher.externalRef! };
}

const reasons = (r: TimetableImportReport) => r.rejected.map((x) => [x.line, x.reason]);

describe("timetable import: report (owner, rolled back)", () => {
  it(
    "inserts good rows; rejects bad rows with the right reason; re-import rejects every row as duplicate",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const math10 = await codes(tx, "MATH-10");
        const math11 = await codes(tx, "MATH-11"); // same teacher as MATH-10
        const lang10 = await codes(tx, "LANG-10");
        const eng10 = await codes(tx, "ENG-10"); // same students as MATH-10
        const term = await tx.term.findFirstOrThrow({ where: { tenantId: TENANT_A }, orderBy: { sequence: "asc" } });
        const csv = [
          "Day,Start,End,Course,Section,Teacher,Room,Term", // line 1 (header, mixed case)
          `1,08:00,08:45,MATH-10,${math10.section},${math10.teacher},R1,`, // 2 ok
          `Mon,08:45,09:30,math-10,${math10.section},${math10.teacher},R1,`, // 3 ok (adjacent, case-insensitive codes)
          `2,08:00,08:45,LANG-10,${lang10.section},${lang10.teacher},,${term.key}`, // 4 ok (no room, termed)
          `9,08:00,08:45,MATH-10,${math10.section},,,`, // 5 bad day
          `3,8am,09:00,MATH-10,${math10.section},,,`, // 6 bad time
          `3,,09:00,MATH-10,${math10.section},,,`, // 7 empty time
          `3,10:00,09:00,MATH-10,${math10.section},,,`, // 8 end before start
          `3,08:00,08:45,NOPE-10,${math10.section},,,`, // 9 unknown section (course)
          `3,08:00,08:45,MATH-10,ZZ-9,,,`, // 10 unknown section (code)
          `3,08:00,08:45,MATH-10,${math10.section},T-999,,`, // 11 unknown teacher
          `3,08:00,08:45,MATH-10,${math10.section},${lang10.teacher},,`, // 12 teacher not assigned to section
          `3,08:00,08:45,MATH-10,${math10.section},,Basement,`, // 13 unknown room (allow-list)
          `3,08:00,08:45,MATH-10,${math10.section},,,term-99`, // 14 unknown term
          `1,08:30,09:15,MATH-11,${math11.section},${math11.teacher},R2,`, // 15 conflict: teacher
          `1,08:15,08:30,LANG-10,${lang10.section},,r1,`, // 16 conflict: room (also students) -> room first
          `1,09:00,09:10,MATH-10,${math10.section},,,`, // 17 conflict: section
          `1,08:00,08:45,ENG-10,${eng10.section},${eng10.teacher},R3,`, // 18 conflict: student
          `1,08:00,08:45,MATH-10,${math10.section},${math10.teacher},R1,`, // 19 duplicate of line 2
          `1,08:00`, // 20 malformed: wrong field count
          `1,"08:00"x,08:45,MATH-10,${math10.section},,,`, // 21 malformed: junk after quote
          "", // trailing newline
        ].join("\n");
        const first = await importTimetableCsv(tx, csv, { tenantId: TENANT_A, rooms: ["R1", "R2", "R3"] });
        const countAfterFirst = await tx.timetableSlot.count({ where: { tenantId: TENANT_A } });
        const second = await importTimetableCsv(tx, csv, { tenantId: TENANT_A, rooms: ["R1", "R2", "R3"] });
        const countAfterSecond = await tx.timetableSlot.count({ where: { tenantId: TENANT_A } });
        const termed = await tx.timetableSlot.findFirstOrThrow({ where: { id: first.accepted[2]!.slotId } });
        return { first, second, countAfterFirst, countAfterSecond, termId: term.id, termed };
      });

      expect(r.first.totalRows).toBe(20);
      expect(r.first.accepted.map((a) => a.line)).toEqual([2, 3, 4]);
      expect(r.termed).toMatchObject({ termId: r.termId, room: null, dayOfWeek: 2 });
      expect(reasons(r.first)).toEqual([
        [5, "bad_day"],
        [6, "bad_time"],
        [7, "bad_time"],
        [8, "bad_time"],
        [9, "unknown_section"],
        [10, "unknown_section"],
        [11, "unknown_teacher"],
        [12, "unknown_teacher"],
        [13, "unknown_room"],
        [14, "unknown_term"],
        [15, "conflict"],
        [16, "conflict"],
        [17, "conflict"],
        [18, "conflict"],
        [19, "duplicate"],
        [20, "malformed_row"],
        [21, "malformed_row"],
      ]);
      const byLine = new Map(r.first.rejected.map((x) => [x.line, x]));
      const line2 = r.first.accepted[0]!.slotId;
      expect(byLine.get(15)!.conflict).toMatchObject({ kind: "teacher", slotId: line2 });
      expect(byLine.get(16)!.conflict).toMatchObject({ kind: "room", slotId: line2, room: "R1" });
      expect(byLine.get(17)!.conflict).toMatchObject({ kind: "section", slotId: r.first.accepted[1]!.slotId });
      expect(byLine.get(18)!.conflict).toMatchObject({ kind: "student", slotId: line2 });
      expect(byLine.get(19)!.conflict).toMatchObject({ kind: "duplicate", slotId: line2 });
      expect(byLine.get(15)!.message).toMatch(/teacher/);
      expect(byLine.get(11)!.message).toContain("T-999");
      expect(r.countAfterFirst).toBe(3);

      // Re-import: nothing inserted twice; the good rows come back as duplicates.
      expect(r.second.accepted).toEqual([]);
      expect(r.countAfterSecond).toBe(3);
      const second = new Map(r.second.rejected.map((x) => [x.line, x.reason]));
      expect([second.get(2), second.get(3), second.get(4)]).toEqual(["duplicate", "duplicate", "duplicate"]);
      expect(await owner.timetableSlot.count({ where: { tenantId: TENANT_A } })).toBe(0);
    },
    240_000,
  );

  it(
    "without a room allow-list any room is accepted; columns may come in any order; optional columns may be absent",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const math10 = await codes(tx, "MATH-10");
        const csv = `section,course,end,start,day,room\n${math10.section},MATH-10,14:45,14:00,friday,"Room ""B"", 2nd floor"\n`;
        const report = await importTimetableCsv(tx, csv, { tenantId: TENANT_A });
        const slot = await tx.timetableSlot.findFirstOrThrow({ where: { id: report.accepted[0]!.slotId } });
        return { report, slot };
      });
      expect(r.report.rejected).toEqual([]);
      expect(r.report.accepted).toHaveLength(1);
      expect(r.slot).toMatchObject({ dayOfWeek: 5, room: 'Room "B", 2nd floor', teacherAssignmentId: null, termId: null });
    },
    120_000,
  );

  it("whole-file problems throw TimetableImportError (empty file, missing required columns)", async () => {
    await ownerRolledBack(async (tx) => {
      await expect(importTimetableCsv(tx, "", { tenantId: TENANT_A })).rejects.toBeInstanceOf(TimetableImportError);
      await expect(importTimetableCsv(tx, "day,start,end,course\n1,08:00,09:00,MATH-10\n", { tenantId: TENANT_A })).rejects.toThrow(
        /missing required column\(s\): section/,
      );
    });
  }, 60_000);
});
