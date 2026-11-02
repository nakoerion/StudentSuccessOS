/**
 * Gradebook service (slice 4a): recordGradeEntry, the event invariant, validation,
 * listGradeEntries through RLS, and the write protection of the derived tables.
 *
 * Write cases run as the owner inside a transaction that is rolled back, so the shared
 * database is left exactly as seeded. The RLS cases commit a few rows through the
 * service, read them through the app role and delete them again.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deriveAnnualGrade,
  deriveTermGrade,
  getAnnualGrade,
  getTermGrade,
  GradebookError,
  listGradeEntries,
  recordGradeEntry,
  type GradebookErrorCode,
} from "../src/gradebook";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

const NIL = "00000000-0000-4000-8000-000000000000";

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}
async function expectCode(p: Promise<unknown>, code: GradebookErrorCode) {
  const e = await rejects(p);
  expect(e).toBeInstanceOf(GradebookError);
  expect((e as GradebookError).code).toBe(code);
}

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

type Db = Prisma.TransactionClient | PrismaClient;

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

interface Fx {
  courseId: string;
  scaleId: string;
  yearId: string;
  teacherPersonId: string;
  enrollments: { id: string; studentPersonId: string }[];
  categories: { id: string; name: string }[];
  terms: { id: string; key: string }[];
}
/** A seeded course's section: enrollments, categories (by name), terms (by sequence), teacher. */
async function fixture(db: Db, tenantId: string, courseCode: string): Promise<Fx> {
  const s = await db.classSection.findFirstOrThrow({
    where: { tenantId, course: { code: courseCode } },
    select: {
      teacherAssignments: { select: { teacherPersonId: true } },
      enrollments: { where: { status: "active" }, select: { id: true, studentPersonId: true }, orderBy: { studentPersonId: "asc" } },
      course: {
        select: {
          id: true,
          gradeScaleId: true,
          academicYearId: true,
          assessmentCategories: { select: { id: true, name: true }, orderBy: { name: "asc" } },
          academicYear: { select: { terms: { select: { id: true, key: true }, orderBy: { sequence: "asc" } } } },
        },
      },
    },
  });
  return {
    courseId: s.course.id,
    scaleId: s.course.gradeScaleId!,
    yearId: s.course.academicYearId,
    teacherPersonId: s.teacherAssignments[0]!.teacherPersonId,
    enrollments: s.enrollments,
    categories: s.course.assessmentCategories,
    terms: s.course.academicYear.terms,
  };
}

const entry = (fx: Fx, rawMark: number | string, over: Partial<Parameters<typeof recordGradeEntry>[1]> = {}) => ({
  tenantId: over.tenantId ?? TENANT_A,
  enrollmentId: fx.enrollments[0]!.id,
  assessmentCategoryId: fx.categories[0]!.id,
  termId: fx.terms[0]!.id,
  rawMark,
  ...over,
});

describe("gradebook: recordGradeEntry (owner, rolled back)", () => {
  it(
    "golden: writes the entry and exactly one grade_entry.created Event in the same transaction",
    async () => {
      const entriesBefore = await owner.gradeEntry.count();
      const eventsBefore = await owner.event.count({ where: { type: "grade_entry.created" } });
      await ownerRolledBack(async (tx) => {
        const fx = await fixture(tx, TENANT_A, "MATH-10");
        const before = await tx.event.count({ where: { tenantId: TENANT_A } });
        const rec = await recordGradeEntry(tx, entry(fx, 8, { gradedByPersonId: fx.teacherPersonId, comment: "  good  " }));
        expect(rec).toMatchObject({
          tenantId: TENANT_A,
          enrollmentId: fx.enrollments[0]!.id,
          studentPersonId: fx.enrollments[0]!.studentPersonId,
          assessmentCategoryId: fx.categories[0]!.id,
          termId: fx.terms[0]!.id,
          gradeScaleId: fx.scaleId, // defaulted to the course's scale
          rawMark: 8,
          percentage: 80,
          gradedByPersonId: fx.teacherPersonId,
          comment: "good",
          assignmentId: null,
        });
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + 1);
        const events = await tx.event.findMany({ where: { tenantId: TENANT_A, entityId: rec.id } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "grade_entry.created",
          actorPersonId: fx.teacherPersonId,
          subjectPersonId: fx.enrollments[0]!.studentPersonId,
          entityType: "grade_entry",
          entityId: rec.id,
          payload: { rawMark: 8, categoryId: fx.categories[0]!.id, termId: fx.terms[0]!.id, scaleId: fx.scaleId },
        });
        // A failing write (unknown grader, checked before any insert) adds nothing.
        await expectCode(recordGradeEntry(tx, entry(fx, 8, { gradedByPersonId: NIL })), "unknown_grader");
        expect(await tx.event.count({ where: { tenantId: TENANT_A } })).toBe(before + 1);
        expect(await tx.gradeEntry.count({ where: { tenantId: TENANT_A } })).toBe(1);
      });
      // Rolled back together: neither the entry nor its event survived.
      expect(await owner.gradeEntry.count()).toBe(entriesBefore);
      expect(await owner.event.count({ where: { type: "grade_entry.created" } })).toBe(eventsBefore);
    },
    120_000,
  );

  it(
    "N entries → N events; boundary min/max accepted on both scales; marks stored to 2 dp (half-up)",
    async () => {
      await ownerRolledBack(async (tx) => {
        const al = await fixture(tx, TENANT_A, "MATH-10");
        const ae = await fixture(tx, TENANT_B, "MATH-10");
        const before = await tx.event.count({ where: { type: "grade_entry.created" } });
        const recs = [
          await recordGradeEntry(tx, entry(al, 4)),
          await recordGradeEntry(tx, entry(al, 10)),
          await recordGradeEntry(tx, entry(al, 7.255)),
          await recordGradeEntry(tx, entry(al, "8.5")),
          await recordGradeEntry(tx, entry(ae, 0, { tenantId: TENANT_B })),
          await recordGradeEntry(tx, entry(ae, 100, { tenantId: TENANT_B })),
          await recordGradeEntry(tx, entry(ae, 87.4849, { tenantId: TENANT_B })),
        ];
        expect(recs.map((r) => r.rawMark)).toEqual([4, 10, 7.26, 8.5, 0, 100, 87.48]);
        expect(recs.map((r) => r.percentage)).toEqual([40, 100, 72.6, 85, 0, 100, 87.48]);
        expect(await tx.event.count({ where: { type: "grade_entry.created" } })).toBe(before + recs.length);
        for (const r of recs) expect(await tx.event.count({ where: { entityId: r.id } })).toBe(1);
        const stored = await tx.gradeEntry.findMany({ where: { id: { in: recs.map((r) => r.id) } }, select: { id: true, rawMark: true } });
        const byId = new Map(stored.map((s) => [s.id, s.rawMark.toString()]));
        expect(byId.get(recs[2]!.id)).toBe("7.26");
        expect(byId.get(recs[6]!.id)).toBe("87.48");
        const ev = await tx.event.findFirstOrThrow({ where: { entityId: recs[2]!.id } });
        expect((ev.payload as { rawMark: number }).rawMark).toBe(7.26);
      });
    },
    120_000,
  );

  it(
    "rejects unknown / foreign enrollment, category, term, scale, grader and assignment",
    async () => {
      await ownerRolledBack(async (tx) => {
        const al = await fixture(tx, TENANT_A, "MATH-10");
        const ae = await fixture(tx, TENANT_B, "MATH-10");
        const foreignAssignment = await tx.assignment.create({
          data: { tenantId: TENANT_B, classSectionId: (await tx.classSection.findFirstOrThrow({ where: { tenantId: TENANT_B } })).id, title: "B" },
        });
        const before = await tx.gradeEntry.count();
        const cases: [Partial<Parameters<typeof recordGradeEntry>[1]>, GradebookErrorCode][] = [
          [{ enrollmentId: NIL }, "unknown_enrollment"],
          [{ enrollmentId: "not-a-uuid" }, "unknown_enrollment"],
          [{ enrollmentId: ae.enrollments[0]!.id }, "unknown_enrollment"],
          [{ assessmentCategoryId: NIL }, "unknown_category"],
          [{ assessmentCategoryId: ae.categories[0]!.id }, "unknown_category"],
          [{ termId: NIL }, "unknown_term"],
          [{ termId: ae.terms[0]!.id }, "unknown_term"],
          [{ gradeScaleId: NIL }, "unknown_scale"],
          [{ gradeScaleId: ae.scaleId }, "unknown_scale"], // the other pack's default scale
          [{ gradedByPersonId: NIL }, "unknown_grader"],
          [{ gradedByPersonId: ae.teacherPersonId }, "unknown_grader"],
          [{ assignmentId: NIL }, "unknown_assignment"],
          [{ assignmentId: foreignAssignment.id }, "unknown_assignment"],
        ];
        for (const [over, code] of cases) await expectCode(recordGradeEntry(tx, entry(al, 7, over)), code);
        expect(await tx.gradeEntry.count()).toBe(before);
      });
    },
    120_000,
  );

  it(
    "rejects a category of a different course in the same tenant, and a term of another academic year",
    async () => {
      await ownerRolledBack(async (tx) => {
        const math = await fixture(tx, TENANT_A, "MATH-10");
        const lang = await fixture(tx, TENANT_A, "LANG-11");
        await expectCode(recordGradeEntry(tx, entry(math, 7, { assessmentCategoryId: lang.categories[0]!.id })), "category_course_mismatch");
        const year = await tx.academicYear.create({
          data: { tenantId: TENANT_A, name: "2027-2028", startsOn: new Date("2027-09-13"), endsOn: new Date("2028-06-16") },
        });
        const otherTerm = await tx.term.create({
          data: { tenantId: TENANT_A, academicYearId: year.id, key: "p1", name: "P1", sequence: 1, startsOn: new Date("2027-09-13"), endsOn: new Date("2028-01-31") },
        });
        await expectCode(recordGradeEntry(tx, entry(math, 7, { termId: otherTerm.id })), "term_year_mismatch");
        expect(await tx.gradeEntry.count({ where: { tenantId: TENANT_A } })).toBe(0);
      });
    },
    120_000,
  );

  it(
    "rejects marks outside min..max and anything that is not a number",
    async () => {
      await ownerRolledBack(async (tx) => {
        const al = await fixture(tx, TENANT_A, "MATH-10");
        const ae = await fixture(tx, TENANT_B, "MATH-10");
        for (const m of [3.99, 10.01, 0, -4, 11]) await expectCode(recordGradeEntry(tx, entry(al, m)), "mark_out_of_range");
        for (const m of [-0.01, 100.01]) await expectCode(recordGradeEntry(tx, entry(ae, m, { tenantId: TENANT_B })), "mark_out_of_range");
        for (const m of [Number.NaN, Number.POSITIVE_INFINITY, "abc", "", "7,5", "1e1", null, undefined, {}] as unknown[])
          await expectCode(recordGradeEntry(tx, entry(al, m as number)), "not_a_number");
        expect(await tx.gradeEntry.count()).toBe(0);
        expect(await tx.event.count({ where: { type: "grade_entry.created" } })).toBe(0);
      });
    },
    120_000,
  );
});

describe("gradebook: reads and RLS", () => {
  it(
    "listGradeEntries filters by enrollment / term / category for the owner and through the app role (RLS)",
    async () => {
      const al = await fixture(owner, TENANT_A, "MATH-10");
      const ae = await fixture(owner, TENANT_B, "MATH-10");
      const [c0, c1] = al.categories;
      const [t1, t2] = al.terms;
      const [e0, e1] = al.enrollments;
      const created: string[] = [];
      const rec = async (input: Parameters<typeof recordGradeEntry>[1]) => created.push((await recordGradeEntry(owner, input)).id);
      try {
        await rec({ tenantId: TENANT_A, enrollmentId: e0!.id, assessmentCategoryId: c0!.id, termId: t1!.id, rawMark: 8 });
        await rec({ tenantId: TENANT_A, enrollmentId: e0!.id, assessmentCategoryId: c1!.id, termId: t1!.id, rawMark: 7 });
        await rec({ tenantId: TENANT_A, enrollmentId: e0!.id, assessmentCategoryId: c0!.id, termId: t2!.id, rawMark: 9 });
        await rec({ tenantId: TENANT_A, enrollmentId: e1!.id, assessmentCategoryId: c0!.id, termId: t1!.id, rawMark: 6 });
        await rec({ tenantId: TENANT_B, enrollmentId: ae.enrollments[0]!.id, assessmentCategoryId: ae.categories[0]!.id, termId: ae.terms[0]!.id, rawMark: 91 });

        const marks = (rows: { rawMark: number }[]) => rows.map((r) => r.rawMark).sort((a, b) => a - b);
        const query = async (db: Db) => ({
          all: marks(await listGradeEntries(db, { tenantId: TENANT_A })),
          enrollment: marks(await listGradeEntries(db, { tenantId: TENANT_A, enrollmentId: e0!.id })),
          term: marks(await listGradeEntries(db, { tenantId: TENANT_A, enrollmentId: e0!.id, termId: t1!.id })),
          category: marks(await listGradeEntries(db, { tenantId: TENANT_A, assessmentCategoryId: c0!.id })),
          student: marks(await listGradeEntries(db, { tenantId: TENANT_A, studentPersonId: e1!.studentPersonId })),
        });
        const expected = { all: [6, 7, 8, 9], enrollment: [7, 8, 9], term: [7, 8], category: [6, 8, 9], student: [6] };
        expect(await query(owner)).toEqual(expected);
        const asA = await withTenant(TENANT_A, async (tx) => ({ ...(await query(tx)), scan: await tx.gradeEntry.count() }), { client: app });
        expect(asA).toEqual({ ...expected, scan: 4 });
        const asB = await withTenant(
          TENANT_B,
          async (tx) => ({
            foreign: await listGradeEntries(tx, { tenantId: TENANT_A }),
            own: (await listGradeEntries(tx, { tenantId: TENANT_B })).map((r) => [r.rawMark, r.percentage]),
          }),
          { client: app },
        );
        expect(asB).toEqual({ foreign: [], own: [[91, 91]] });
      } finally {
        await owner.event.deleteMany({ where: { entityId: { in: created } } });
        await owner.gradeEntry.deleteMany({ where: { id: { in: created } } });
      }
      expect(await owner.gradeEntry.count()).toBe(0);
    },
    180_000,
  );

  it(
    "derived grades are readable through the app role only inside their tenant",
    async () => {
      const al = await fixture(owner, TENANT_A, "MATH-10");
      const e0 = al.enrollments[0]!;
      const created: string[] = [];
      try {
        created.push((await recordGradeEntry(owner, entry(al, 9.4))).id);
        await deriveTermGrade(owner, { tenantId: TENANT_A, enrollmentId: e0.id, termId: al.terms[0]!.id });
        await deriveAnnualGrade(owner, { tenantId: TENANT_A, enrollmentId: e0.id, academicYearId: al.yearId });
        const args = { tenantId: TENANT_A, enrollmentId: e0.id };
        const asA = await withTenant(
          TENANT_A,
          async (tx) => ({
            term: await getTermGrade(tx, { ...args, termId: al.terms[0]!.id }),
            annual: await getAnnualGrade(tx, { ...args, academicYearId: al.yearId }),
          }),
          { client: app },
        );
        expect(asA.term).toMatchObject({ percentage: 94, value: 9, label: "9", passing: true, gpa: 4, matura: 9 });
        expect(asA.annual).toMatchObject({ percentage: 94, value: 9, label: "9" });
        const asB = await withTenant(
          TENANT_B,
          async (tx) => ({
            term: await getTermGrade(tx, { ...args, termId: al.terms[0]!.id }),
            annual: await getAnnualGrade(tx, { ...args, academicYearId: al.yearId }),
            scan: (await tx.termGrade.count()) + (await tx.annualGrade.count()),
          }),
          { client: app },
        );
        expect(asB).toEqual({ term: null, annual: null, scan: 0 });
      } finally {
        await owner.annualGrade.deleteMany({ where: { enrollmentId: e0.id } });
        await owner.termGrade.deleteMany({ where: { enrollmentId: e0.id } });
        await owner.event.deleteMany({ where: { entityId: { in: created } } });
        await owner.gradeEntry.deleteMany({ where: { id: { in: created } } });
      }
      expect(await owner.termGrade.count()).toBe(0);
    },
    180_000,
  );

  it(
    "term_grade / annual_grade: INSERT, UPDATE and DELETE are denied to ssos_app",
    async () => {
      const al = await fixture(owner, TENANT_A, "MATH-10");
      const e0 = al.enrollments[0]!;
      const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
        ["insert term_grade", (tx) => tx.termGrade.create({ data: { tenantId: TENANT_A, enrollmentId: e0.id, termId: al.terms[0]!.id, gradeScaleId: al.scaleId, value: 10, percentage: 100 } })],
        ["update term_grade", (tx) => tx.termGrade.updateMany({ where: { tenantId: TENANT_A }, data: { value: 10 } })],
        ["delete term_grade", (tx) => tx.termGrade.deleteMany({ where: { tenantId: TENANT_A } })],
        ["insert annual_grade", (tx) => tx.annualGrade.create({ data: { tenantId: TENANT_A, enrollmentId: e0.id, academicYearId: al.yearId, gradeScaleId: al.scaleId, value: 10, percentage: 100 } })],
        ["update annual_grade", (tx) => tx.annualGrade.updateMany({ where: { tenantId: TENANT_A }, data: { value: 10 } })],
        ["delete annual_grade", (tx) => tx.annualGrade.deleteMany({ where: { tenantId: TENANT_A } })],
      ];
      for (const [what, run] of attempts) {
        const e = await rejects(withTenant(TENANT_A, run, { client: app }));
        expect([what, String((e as Error).message)]).toEqual([what, expect.stringMatching(/permission denied/i)]);
      }
      expect(await owner.termGrade.count()).toBe(0);
      expect(await owner.annualGrade.count()).toBe(0);
    },
    180_000,
  );

  it("ssos_app holds SELECT only on term_grade and annual_grade", async () => {
    const rows = await owner.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name::text, privilege_type::text FROM information_schema.role_table_grants
      WHERE grantee = 'ssos_app' AND table_schema = 'public' AND table_name IN ('term_grade', 'annual_grade')
      ORDER BY table_name, privilege_type`;
    expect(rows).toEqual([
      { table_name: "annual_grade", privilege_type: "SELECT" },
      { table_name: "term_grade", privilege_type: "SELECT" },
    ]);
    const [p] = await owner.$queryRaw<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }[]>`
      SELECT has_table_privilege('ssos_app', 'term_grade', 'INSERT') OR has_table_privilege('ssos_app', 'annual_grade', 'INSERT') AS ins,
             has_table_privilege('ssos_app', 'term_grade', 'UPDATE') OR has_table_privilege('ssos_app', 'annual_grade', 'UPDATE') AS upd,
             has_table_privilege('ssos_app', 'term_grade', 'DELETE') OR has_table_privilege('ssos_app', 'annual_grade', 'DELETE') AS del,
             has_table_privilege('ssos_app', 'term_grade', 'SELECT') AND has_table_privilege('ssos_app', 'annual_grade', 'SELECT') AS sel`;
    expect(p).toEqual({ ins: false, upd: false, del: false, sel: true });
  });
});
