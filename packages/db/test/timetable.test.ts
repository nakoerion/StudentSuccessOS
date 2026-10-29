/**
 * Timetable service (slice 3a): pure conflict rules + the database service.
 *
 * Database cases run as the owner inside a transaction that is rolled back, so the
 * shared database is left exactly as seeded. One case commits two slots to prove the
 * grid queries work through the app role (ssos_app, RLS) and cleans them up.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTimetableSlot,
  findSlotConflict,
  formatTime,
  hasTimeOverlap,
  listTimetableForRoom,
  listTimetableForStudent,
  listTimetableForTeacher,
  parseTime,
  TimetableConflictError,
  TimetableValidationError,
  type ConflictSlot,
  type CreateTimetableSlotInput,
  type SlotConflictKind,
  type TimetableValidationCode,
} from "../src/timetable";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

// ─── Pure ────────────────────────────────────────────────────────────────────

const slot = (over: Partial<ConflictSlot> = {}): ConflictSlot => ({
  id: "existing",
  classSectionId: "sec-1",
  teacherAssignmentId: "ta-1",
  teacherPersonId: "teacher-1",
  room: "R1",
  termId: null,
  dayOfWeek: 1,
  startsAt: "08:00",
  endsAt: "08:45",
  studentPersonIds: ["s1", "s2"],
  ...over,
});
const candidate = (over: Partial<ConflictSlot> = {}): ConflictSlot => {
  const c = slot({
    classSectionId: "sec-2",
    teacherAssignmentId: "ta-2",
    teacherPersonId: "teacher-2",
    room: "R2",
    studentPersonIds: ["s3"],
    ...over,
  });
  delete c.id;
  return c;
};

describe("timetable: pure helpers", () => {
  it("parseTime / formatTime accept HH:MM and HH:MM:SS, reject garbage", () => {
    expect(parseTime("08:00")).toBe(480);
    expect(parseTime("8:05")).toBe(485);
    expect(parseTime(" 13:30:00 ")).toBe(810);
    for (const bad of ["", "24:00", "12:60", "noon", "12", "12:3", "-1:00"]) expect(parseTime(bad)).toBeNull();
    expect(formatTime(485)).toBe("08:05");
  });

  it("hasTimeOverlap uses half-open ranges: adjacent periods do not overlap", () => {
    const p = (startsAt: string, endsAt: string) => ({ startsAt, endsAt });
    expect(hasTimeOverlap(p("08:00", "08:45"), p("08:30", "09:15"))).toBe(true);
    expect(hasTimeOverlap(p("08:00", "09:00"), p("08:15", "08:30"))).toBe(true); // containment
    expect(hasTimeOverlap(p("08:00", "08:45"), p("08:00", "08:45"))).toBe(true); // identical
    expect(hasTimeOverlap(p("08:00", "08:45"), p("08:45", "09:30"))).toBe(false); // adjacent
    expect(hasTimeOverlap(p("08:45", "09:30"), p("08:00", "08:45"))).toBe(false);
    expect(hasTimeOverlap(p("08:00", "08:45"), p("10:00", "10:45"))).toBe(false);
  });

  it("no conflict when nothing is shared, on a different day, or adjacent", () => {
    expect(findSlotConflict(candidate(), [slot()])).toBeNull();
    expect(findSlotConflict(candidate({ classSectionId: "sec-1", dayOfWeek: 2 }), [slot()])).toBeNull();
    expect(findSlotConflict(candidate({ classSectionId: "sec-1", startsAt: "08:45", endsAt: "09:30" }), [slot()])).toBeNull();
  });

  const cases: [string, Partial<ConflictSlot>, SlotConflictKind, Partial<ReturnType<typeof findSlotConflict>>][] = [
    ["section", { classSectionId: "sec-1", startsAt: "08:30", endsAt: "09:00" }, "section", {}],
    ["teacher", { teacherPersonId: "teacher-1", startsAt: "08:30", endsAt: "09:15" }, "teacher", { teacherPersonId: "teacher-1" }],
    ["room (trimmed, case-insensitive)", { room: " r1 " }, "room", { room: "R1" }],
    ["student", { studentPersonIds: ["s9", "s2"] }, "student", { studentPersonId: "s2" }],
    ["duplicate", { classSectionId: "sec-1", teacherAssignmentId: "ta-1", teacherPersonId: "teacher-1", room: "R1", studentPersonIds: ["s1", "s2"] }, "duplicate", {}],
  ];
  for (const [label, over, kind, extra] of cases) {
    it(`detects a ${label} conflict`, () => {
      expect(findSlotConflict(candidate(over), [slot()])).toEqual({
        kind,
        slotId: "existing",
        dayOfWeek: 1,
        startsAt: "08:00",
        endsAt: "08:45",
        classSectionId: "sec-1",
        ...extra,
      });
    });
  }

  it("terms: different terms never clash; a NULL (all-year) term clashes with every term", () => {
    const termed = slot({ termId: "t1" });
    expect(findSlotConflict(candidate({ classSectionId: "sec-1", termId: "t2" }), [termed])).toBeNull();
    expect(findSlotConflict(candidate({ classSectionId: "sec-1", termId: "t1" }), [termed])?.kind).toBe("section");
    expect(findSlotConflict(candidate({ classSectionId: "sec-1", termId: null }), [termed])?.kind).toBe("section");
  });

  it("precedence: section beats teacher beats room beats student", () => {
    const all = { classSectionId: "sec-1", teacherPersonId: "teacher-1", room: "R1", studentPersonIds: ["s1"], startsAt: "08:10" };
    expect(findSlotConflict(candidate(all), [slot()])?.kind).toBe("section");
    expect(findSlotConflict(candidate({ ...all, classSectionId: "x" }), [slot()])?.kind).toBe("teacher");
    expect(findSlotConflict(candidate({ ...all, classSectionId: "x", teacherPersonId: "y" }), [slot()])?.kind).toBe("room");
    expect(findSlotConflict(candidate({ ...all, classSectionId: "x", teacherPersonId: "y", room: null }), [slot()])?.kind).toBe(
      "student",
    );
  });

  it("slots without a teacher or room never clash on teacher/room", () => {
    const bare = slot({ teacherPersonId: null, teacherAssignmentId: null, room: null, studentPersonIds: [] });
    expect(findSlotConflict(candidate({ teacherPersonId: null, room: null }), [bare])).toBeNull();
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
  students: string[];
}
/** The seeded section of a course (one per course in the fixtures) + its primary teacher assignment. */
async function section(db: Prisma.TransactionClient | PrismaClient, tenantId: string, courseCode: string): Promise<Sec> {
  const s = await db.classSection.findFirstOrThrow({
    where: { tenantId, course: { code: courseCode } },
    select: {
      id: true,
      teacherAssignments: { select: { id: true, teacherPersonId: true } },
      enrollments: { where: { status: "active" }, select: { studentPersonId: true } },
    },
  });
  return {
    id: s.id,
    taId: s.teacherAssignments[0]!.id,
    teacherPersonId: s.teacherAssignments[0]!.teacherPersonId,
    students: s.enrollments.map((e) => e.studentPersonId).sort(),
  };
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject");
}
async function expectConflict(p: Promise<unknown>, kind: SlotConflictKind, slotId: string) {
  const e = await rejects(p);
  expect(e).toBeInstanceOf(TimetableConflictError);
  expect((e as TimetableConflictError).conflict).toMatchObject({ kind, slotId });
  return (e as TimetableConflictError).conflict;
}
async function expectInvalid(p: Promise<unknown>, code: TimetableValidationCode) {
  const e = await rejects(p);
  expect(e).toBeInstanceOf(TimetableValidationError);
  expect((e as TimetableValidationError).code).toBe(code);
}

describe("timetable: createTimetableSlot golden cases (owner, rolled back)", () => {
  it(
    "rejects teacher / room / section / student / duplicate collisions; accepts adjacent and other-day slots",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const math11 = await section(tx, TENANT_A, "MATH-11"); // same teacher as MATH-10, other students
        const lang11 = await section(tx, TENANT_A, "LANG-11"); // other teacher, other students
        const eng10 = await section(tx, TENANT_A, "ENG-10"); // other teacher, SAME students as MATH-10
        expect(math11.teacherPersonId).toBe(math10.teacherPersonId);
        expect(lang11.teacherPersonId).not.toBe(math10.teacherPersonId);
        expect(eng10.teacherPersonId).not.toBe(math10.teacherPersonId);
        expect(eng10.students).toEqual(math10.students);
        expect(math10.students.length).toBeGreaterThan(0);

        const mk = (s: Sec, over: Partial<CreateTimetableSlotInput>) =>
          createTimetableSlot(tx, { tenantId: TENANT_A, classSectionId: s.id, teacherAssignmentId: s.taId, dayOfWeek: 1, startsAt: "08:00", endsAt: "08:45", ...over });

        const first = await mk(math10, { room: "R1" });
        expect(first).toMatchObject({ dayOfWeek: 1, startsAt: "08:00", endsAt: "08:45", room: "R1", termId: null });

        const teacher = await expectConflict(mk(math11, { room: "R2", startsAt: "08:30", endsAt: "09:15" }), "teacher", first.id);
        expect(teacher.teacherPersonId).toBe(math10.teacherPersonId);
        const room = await expectConflict(mk(lang11, { room: " r1 ", startsAt: "08:15", endsAt: "08:30" }), "room", first.id);
        expect(room.room).toBe("R1");
        await expectConflict(mk(math10, { teacherAssignmentId: null, startsAt: "08:40", endsAt: "09:00" }), "section", first.id);
        const student = await expectConflict(mk(eng10, { room: "R3" }), "student", first.id);
        expect(math10.students).toContain(student.studentPersonId);
        await expectConflict(mk(math10, { room: "R1" }), "duplicate", first.id);

        // Accepted: adjacent (same teacher, room, section, students) and a different day.
        const adjacent = await mk(math10, { room: "R1", startsAt: "08:45", endsAt: "09:30" });
        const tuesday = await mk(math11, { room: "R1", dayOfWeek: 2 });
        // Accepted: room-less, teacher-less slot for another section/grade at an overlapping time.
        const bare = await mk(lang11, { teacherAssignmentId: null, startsAt: "08:15", endsAt: "08:30" });

        return {
          count: await tx.timetableSlot.count({ where: { tenantId: TENANT_A } }),
          ids: [first.id, adjacent.id, tuesday.id, bare.id],
        };
      });
      expect(r.count).toBe(4);
      expect(new Set(r.ids).size).toBe(4);
      // Rolled back: nothing persisted.
      expect(await owner.timetableSlot.count({ where: { tenantId: TENANT_A } })).toBe(0);
    },
    180_000,
  );

  it(
    "terms: slots in different terms share a period; an all-year slot clashes with a termed one",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const [t1, t2] = await tx.term.findMany({ where: { tenantId: TENANT_A }, orderBy: { sequence: "asc" } });
        const mk = (termId: string | null) =>
          createTimetableSlot(tx, { tenantId: TENANT_A, classSectionId: math10.id, termId, dayOfWeek: 3, startsAt: "10:00", endsAt: "10:45" });
        const a = await mk(t1!.id);
        const b = await mk(t2!.id);
        const e = await rejects(mk(null));
        expect(e).toBeInstanceOf(TimetableConflictError);
        expect((e as TimetableConflictError).conflict.kind).toBe("section");
        expect([a.id, b.id]).toContain((e as TimetableConflictError).conflict.slotId);
      });
    },
    120_000,
  );

  it(
    "validation: bad day, bad times, unknown / foreign section, assignment of another section, term of another tenant",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const eng10 = await section(tx, TENANT_A, "ENG-10");
        const foreign = await section(tx, TENANT_B, "MATH-10");
        const foreignTerm = await tx.term.findFirstOrThrow({ where: { tenantId: TENANT_B } });
        const base: CreateTimetableSlotInput = { tenantId: TENANT_A, classSectionId: math10.id, dayOfWeek: 1, startsAt: "08:00", endsAt: "08:45" };
        await expectInvalid(createTimetableSlot(tx, { ...base, dayOfWeek: 0 }), "bad_day");
        await expectInvalid(createTimetableSlot(tx, { ...base, dayOfWeek: 8 }), "bad_day");
        await expectInvalid(createTimetableSlot(tx, { ...base, startsAt: "9am" }), "bad_time");
        await expectInvalid(createTimetableSlot(tx, { ...base, startsAt: "09:00", endsAt: "09:00" }), "bad_time");
        await expectInvalid(createTimetableSlot(tx, { ...base, classSectionId: "00000000-0000-4000-8000-000000000000" }), "unknown_section");
        await expectInvalid(createTimetableSlot(tx, { ...base, classSectionId: foreign.id }), "unknown_section");
        await expectInvalid(createTimetableSlot(tx, { ...base, teacherAssignmentId: eng10.taId }), "unknown_teacher_assignment");
        await expectInvalid(createTimetableSlot(tx, { ...base, termId: foreignTerm.id }), "unknown_term");
        expect(await tx.timetableSlot.count({ where: { tenantId: TENANT_A } })).toBe(0);
      });
    },
    120_000,
  );
});

describe("timetable: grid queries", () => {
  it(
    "student / teacher / room grids return the right slots ordered by day, then start",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const math10 = await section(tx, TENANT_A, "MATH-10");
        const math11 = await section(tx, TENANT_A, "MATH-11");
        const lang10 = await section(tx, TENANT_A, "LANG-10");
        const mk = (s: Sec, dayOfWeek: number, startsAt: string, endsAt: string, room: string | null) =>
          createTimetableSlot(tx, { tenantId: TENANT_A, classSectionId: s.id, teacherAssignmentId: s.taId, dayOfWeek, startsAt, endsAt, room });
        // Inserted out of order on purpose.
        const tueMath11 = await mk(math11, 2, "08:00", "08:45", "R1");
        const monMath10b = await mk(math10, 1, "09:00", "09:45", "R1");
        const monLang10 = await mk(lang10, 1, "10:00", "10:45", "R2");
        const monMath10a = await mk(math10, 1, "08:00", "08:45", "R1");
        const friLang10 = await mk(lang10, 5, "12:00", "12:45", null);

        const student10 = math10.students[0]!;
        const student11 = math11.students[0]!;
        return {
          ids: { tueMath11, monMath10a, monMath10b, monLang10, friLang10 },
          student10: await listTimetableForStudent(tx, { tenantId: TENANT_A, studentPersonId: student10 }),
          student11: await listTimetableForStudent(tx, { tenantId: TENANT_A, studentPersonId: student11 }),
          mathTeacher: await listTimetableForTeacher(tx, { tenantId: TENANT_A, teacherPersonId: math10.teacherPersonId }),
          langTeacher: await listTimetableForTeacher(tx, { tenantId: TENANT_A, teacherPersonId: lang10.teacherPersonId }),
          r1: await listTimetableForRoom(tx, { tenantId: TENANT_A, room: "r1" }),
          r2: await listTimetableForRoom(tx, { tenantId: TENANT_A, room: "R2" }),
          none: await listTimetableForRoom(tx, { tenantId: TENANT_A, room: "Gym" }),
          otherTenant: await listTimetableForTeacher(tx, { tenantId: TENANT_B, teacherPersonId: math10.teacherPersonId }),
        };
      });
      const { ids } = r;
      const idsOf = (rows: { id: string }[]) => rows.map((x) => x.id);
      expect(idsOf(r.student10)).toEqual([ids.monMath10a.id, ids.monMath10b.id, ids.monLang10.id, ids.friLang10.id]);
      expect(r.student10.map((s) => [s.dayOfWeek, s.startsAt, s.courseCode])).toEqual([
        [1, "08:00", "MATH-10"],
        [1, "09:00", "MATH-10"],
        [1, "10:00", "LANG-10"],
        [5, "12:00", "LANG-10"],
      ]);
      expect(idsOf(r.student11)).toEqual([ids.tueMath11.id]);
      expect(idsOf(r.mathTeacher)).toEqual([ids.monMath10a.id, ids.monMath10b.id, ids.tueMath11.id]);
      expect(r.mathTeacher[0]).toMatchObject({ courseCode: "MATH-10", room: "R1", startsAt: "08:00", endsAt: "08:45" });
      expect(idsOf(r.langTeacher)).toEqual([ids.monLang10.id, ids.friLang10.id]);
      expect(idsOf(r.r1)).toEqual([ids.monMath10a.id, ids.monMath10b.id, ids.tueMath11.id]);
      expect(idsOf(r.r2)).toEqual([ids.monLang10.id]);
      expect(r.none).toEqual([]);
      expect(r.otherTenant).toEqual([]);
    },
    180_000,
  );

  it(
    "through the app role (RLS): a tenant sees its own committed slots and none of the other tenant's",
    async () => {
      const math10 = await section(owner, TENANT_A, "MATH-10");
      const created: string[] = [];
      try {
        created.push(
          (await createTimetableSlot(owner, { tenantId: TENANT_A, classSectionId: math10.id, teacherAssignmentId: math10.taId, dayOfWeek: 4, startsAt: "11:00", endsAt: "11:45", room: "Lab-RLS" })).id,
          (await createTimetableSlot(owner, { tenantId: TENANT_A, classSectionId: math10.id, teacherAssignmentId: math10.taId, dayOfWeek: 2, startsAt: "11:00", endsAt: "11:45", room: "Lab-RLS" })).id,
        );
        const asA = await withTenant(
          TENANT_A,
          async (tx) => ({
            student: await listTimetableForStudent(tx, { tenantId: TENANT_A, studentPersonId: math10.students[0]! }),
            teacher: await listTimetableForTeacher(tx, { tenantId: TENANT_A, teacherPersonId: math10.teacherPersonId }),
            room: await listTimetableForRoom(tx, { tenantId: TENANT_A, room: "lab-rls" }),
          }),
          { client: app },
        );
        expect(asA.student.map((s) => s.id)).toEqual([created[1], created[0]]); // Tue before Thu
        expect(asA.teacher.map((s) => s.id)).toEqual([created[1], created[0]]);
        expect(asA.room.map((s) => s.id)).toEqual([created[1], created[0]]);
        const asB = await withTenant(
          TENANT_B,
          async (tx) => ({
            byTenantArg: await listTimetableForRoom(tx, { tenantId: TENANT_A, room: "Lab-RLS" }),
            scan: await tx.timetableSlot.count(),
          }),
          { client: app },
        );
        expect(asB).toEqual({ byTenantArg: [], scan: 0 });
      } finally {
        await owner.timetableSlot.deleteMany({ where: { id: { in: created } } });
      }
      expect(await owner.timetableSlot.count({ where: { tenantId: TENANT_A } })).toBe(0);
    },
    180_000,
  );
});
