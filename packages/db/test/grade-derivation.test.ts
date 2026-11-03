/**
 * Gradebook derivation (slice 4a): golden term/annual grades for BOTH packs, the
 * half-up rounding edge, weights that do not sum to 100, and the error cases.
 * Every case runs as the owner inside a transaction that is rolled back.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deriveAnnualGrade,
  deriveTermGrade,
  getTermGrade,
  GradebookError,
  recordGradeEntry,
  type GradebookErrorCode,
} from "../src/gradebook";
import { ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

const NIL = "00000000-0000-4000-8000-000000000000";
type Tx = Prisma.TransactionClient;

async function expectCode(p: Promise<unknown>, code: GradebookErrorCode) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GradebookError);
  expect((err as GradebookError).code).toBe(code);
}

let owner: PrismaClient;
beforeAll(() => {
  owner = ownerClient();
});
afterAll(async () => {
  await owner.$disconnect();
});

async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await owner
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 180_000, maxWait: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

interface Fx {
  tenantId: string;
  courseId: string;
  yearId: string;
  enrollments: string[];
  /** Seeded categories, by name. */
  categories: { id: string; name: string; weight: number }[];
  terms: string[];
}
async function fixture(tx: Tx, tenantId: string, courseCode = "MATH-10"): Promise<Fx> {
  const s = await tx.classSection.findFirstOrThrow({
    where: { tenantId, course: { code: courseCode } },
    select: {
      enrollments: { where: { status: "active" }, select: { id: true }, orderBy: { studentPersonId: "asc" } },
      course: {
        select: {
          id: true,
          academicYearId: true,
          assessmentCategories: { select: { id: true, name: true, weight: true }, orderBy: { name: "asc" } },
          academicYear: { select: { terms: { select: { id: true }, orderBy: { sequence: "asc" } } } },
        },
      },
    },
  });
  return {
    tenantId,
    courseId: s.course.id,
    yearId: s.course.academicYearId,
    enrollments: s.enrollments.map((e) => e.id),
    categories: s.course.assessmentCategories.map((c) => ({ id: c.id, name: c.name, weight: c.weight.toNumber() })),
    terms: s.course.academicYear.terms.map((t) => t.id),
  };
}

/** Record marks: [categoryId, mark][] for one enrollment + term. */
async function marks(tx: Tx, fx: Fx, enrollmentId: string, termId: string, list: [string, number][]) {
  for (const [categoryId, rawMark] of list)
    await recordGradeEntry(tx, { tenantId: fx.tenantId, enrollmentId, assessmentCategoryId: categoryId, termId, rawMark });
}

/** Extra categories on the fixture's course (the seeded ones stay, unmarked → skipped). */
async function categories(tx: Tx, fx: Fx, weights: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, weight] of weights.entries())
    ids.push((await tx.assessmentCategory.create({ data: { tenantId: fx.tenantId, courseId: fx.courseId, name: `test-${i}-${weight}`, weight } })).id);
  return ids;
}

const byWeight = (fx: Fx) => [...fx.categories].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

describe("gradebook derivation: term grades", () => {
  it(
    "golden AL: Σ(category average × weight) ÷ Σ(weight) on the 4–10 scale, inputs snapshot, re-derive upserts",
    async () => {
      await rolledBack(async (tx) => {
        const fx = await fixture(tx, TENANT_A);
        expect(fx.categories.map((c) => c.weight).sort()).toEqual([30, 30, 40]);
        const [c40, c30a, c30b] = byWeight(fx);
        const e = fx.enrollments[0]!;
        const t = fx.terms[0]!;
        // c40: 8, 9 → 85%; c30a: 7 → 70%; c30b: 6 → 60%  ⇒ (85×40 + 70×30 + 60×30) ÷ 100 = 73.00 → mark 7.
        await marks(tx, fx, e, t, [[c40!.id, 8], [c40!.id, 9], [c30a!.id, 7], [c30b!.id, 6]]);
        const g = await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: t });
        expect(g).toMatchObject({ termId: t, enrollmentId: e, percentage: 73, value: 7, label: "7", passing: true, gpa: 3, matura: 7 });
        expect(g.inputs).toMatchObject({
          totalWeight: 100,
          categories: expect.arrayContaining([
            expect.objectContaining({ categoryId: c40!.id, weight: 40, entries: 2, average: 85 }),
            expect.objectContaining({ categoryId: c30a!.id, weight: 30, entries: 1, average: 70 }),
            expect.objectContaining({ categoryId: c30b!.id, weight: 30, entries: 1, average: 60 }),
          ]),
        });
        // Only the touched enrollment/term has a grade.
        expect(await tx.termGrade.count({ where: { tenantId: TENANT_A } })).toBe(1);
        // Another mark, re-derive: same row, new value. c30b: 6, 10 → 80% ⇒ (3400 + 2100 + 2400) ÷ 100 = 79 → 8.
        await marks(tx, fx, e, t, [[c30b!.id, 10]]);
        const g2 = await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: t });
        expect(g2).toMatchObject({ id: g.id, percentage: 79, value: 8, label: "8", gpa: 3 });
        expect(await tx.termGrade.count({ where: { tenantId: TENANT_A } })).toBe(1);
        expect(await getTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: t })).toMatchObject({ percentage: 79, value: 8 });
        // A failing mark (D) on a different enrollment.
        const e2 = fx.enrollments[1]!;
        await marks(tx, fx, e2, t, [[c40!.id, 4], [c30a!.id, 5]]);
        // (40×40 + 50×30) ÷ 70 = 44.2857… → 44.29 → mark 4 (fail).
        expect(await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e2, termId: t })).toMatchObject({
          percentage: 44.29, value: 4, label: "4", passing: false, gpa: 0, matura: 4,
        });
      });
    },
    120_000,
  );

  it(
    "golden AE: percentage scale keeps the percentage as the value, letter band B, GPA 3",
    async () => {
      await rolledBack(async (tx) => {
        const fx = await fixture(tx, TENANT_B);
        const [c40, c30a, c30b] = byWeight(fx);
        const e = fx.enrollments[0]!;
        const t = fx.terms[0]!;
        // c40: 92, 88 → 90; c30a: 85; c30b: 87.6  ⇒ (3600 + 2550 + 2628) ÷ 100 = 87.78.
        await marks(tx, fx, e, t, [[c40!.id, 92], [c40!.id, 88], [c30a!.id, 85], [c30b!.id, 87.6]]);
        const g = await deriveTermGrade(tx, { tenantId: TENANT_B, enrollmentId: e, termId: t });
        expect(g).toMatchObject({ percentage: 87.78, value: 87.78, label: "B", passing: true, gpa: 3, matura: 8.47 });
        // Below the pass mark: 59.99 → F.
        const e2 = fx.enrollments[1]!;
        await marks(tx, fx, e2, t, [[c40!.id, 59.99]]);
        expect(await deriveTermGrade(tx, { tenantId: TENANT_B, enrollmentId: e2, termId: t })).toMatchObject({
          percentage: 59.99, label: "F", passing: false, gpa: 0, matura: 4,
        });
      });
    },
    120_000,
  );

  it(
    "rounding edge: 74.995% rounds half-up to 75.00 → 8; 74.994% → 74.99 → 7",
    async () => {
      await rolledBack(async (tx) => {
        const fx = await fixture(tx, TENANT_A);
        const [w1, w19, w3, w47] = await categories(tx, fx, [1, 19, 3, 47]);
        const t = fx.terms[0]!;
        const [eA, eB] = fx.enrollments;
        // (74.9 × 1 + 75 × 19) ÷ 20 = 74.995 exactly.
        await marks(tx, fx, eA!, t, [[w1!, 7.49], [w19!, 7.5]]);
        expect(await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: eA!, termId: t })).toMatchObject({ percentage: 75, value: 8, label: "8" });
        // (74.9 × 3 + 75 × 47) ÷ 50 = 74.994.
        await marks(tx, fx, eB!, t, [[w3!, 7.49], [w47!, 7.5]]);
        expect(await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: eB!, termId: t })).toMatchObject({ percentage: 74.99, value: 7, label: "7" });
      });
    },
    120_000,
  );

  it(
    "weights need not sum to 100: 2/1/1 on both packs",
    async () => {
      await rolledBack(async (tx) => {
        for (const [tenantId, m] of [
          [TENANT_A, [8, 7, 6]],
          [TENANT_B, [80, 70, 60]],
        ] as const) {
          const fx = await fixture(tx, tenantId);
          const [w2, w1a, w1b] = await categories(tx, fx, [2, 1, 1]);
          const e = fx.enrollments[2]!;
          await marks(tx, fx, e, fx.terms[0]!, [[w2!, m[0]], [w1a!, m[1]], [w1b!, m[2]]]);
          // (80 × 2 + 70 + 60) ÷ 4 = 72.5.
          const g = await deriveTermGrade(tx, { tenantId, enrollmentId: e, termId: fx.terms[0]! });
          expect(g.percentage).toBe(72.5);
          expect(g.inputs).toMatchObject({ totalWeight: 4 });
          expect([g.value, g.label]).toEqual(tenantId === TENANT_A ? [7, "7"] : [72.5, "C"]);
        }
      });
    },
    120_000,
  );
});

describe("gradebook derivation: annual grades", () => {
  it(
    "annual = equal-weighted mean of stored term percentages (AL 73 & 94 → 83.5 → 8; AE 87.48, then 77.98 once term 3 exists)",
    async () => {
      await rolledBack(async (tx) => {
        // AL: 2 terms.
        const al = await fixture(tx, TENANT_A);
        const [c40, c30a, c30b] = byWeight(al);
        const e = al.enrollments[0]!;
        await marks(tx, al, e, al.terms[0]!, [[c40!.id, 8], [c40!.id, 9], [c30a!.id, 7], [c30b!.id, 6]]); // 73
        await marks(tx, al, e, al.terms[1]!, [[c40!.id, 9.4]]); // 94
        // Term grades must be derived first.
        await expectCode(deriveAnnualGrade(tx, { tenantId: TENANT_A, enrollmentId: e, academicYearId: al.yearId }), "no_term_grades");
        for (const termId of al.terms) await deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId });
        const a = await deriveAnnualGrade(tx, { tenantId: TENANT_A, enrollmentId: e, academicYearId: al.yearId });
        expect(a).toMatchObject({ academicYearId: al.yearId, percentage: 83.5, value: 8, label: "8", passing: true, gpa: 3, matura: 8 });
        expect((a.inputs as { terms: { percentage: number }[] }).terms.map((t) => t.percentage)).toEqual([73, 94]);

        // AE: 3 terms; term 3 not derived yet → skipped.
        const ae = await fixture(tx, TENANT_B);
        const [b40] = byWeight(ae);
        const eb = ae.enrollments[0]!;
        await marks(tx, ae, eb, ae.terms[0]!, [[b40!.id, 90]]);
        await marks(tx, ae, eb, ae.terms[1]!, [[b40!.id, 84.96]]);
        await deriveTermGrade(tx, { tenantId: TENANT_B, enrollmentId: eb, termId: ae.terms[0]! });
        await deriveTermGrade(tx, { tenantId: TENANT_B, enrollmentId: eb, termId: ae.terms[1]! });
        const a2 = await deriveAnnualGrade(tx, { tenantId: TENANT_B, enrollmentId: eb, academicYearId: ae.yearId });
        expect(a2).toMatchObject({ percentage: 87.48, value: 87.48, label: "B", gpa: 3 });
        await marks(tx, ae, eb, ae.terms[2]!, [[b40!.id, 58.98]]);
        await deriveTermGrade(tx, { tenantId: TENANT_B, enrollmentId: eb, termId: ae.terms[2]! });
        const a3 = await deriveAnnualGrade(tx, { tenantId: TENANT_B, enrollmentId: eb, academicYearId: ae.yearId });
        // (90 + 84.96 + 58.98) ÷ 3 = 77.98; same row, updated.
        expect(a3).toMatchObject({ id: a2.id, percentage: 77.98, value: 77.98, label: "C", gpa: 2 });
        expect(await tx.annualGrade.count({ where: { enrollmentId: eb } })).toBe(1);
      });
    },
    180_000,
  );

  it(
    "errors: no entries, zero total weight, unknown/foreign term and year, unknown enrollment, no term grades",
    async () => {
      await rolledBack(async (tx) => {
        const al = await fixture(tx, TENANT_A);
        const ae = await fixture(tx, TENANT_B);
        const e = al.enrollments[3]!;
        const t = al.terms[0]!;
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: t }), "no_grade_entries");
        const [zero] = await categories(tx, al, [0]);
        await marks(tx, al, e, t, [[zero!, 9]]);
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: t }), "zero_total_weight");
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: NIL }), "unknown_term");
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: e, termId: ae.terms[0]! }), "unknown_term");
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: NIL, termId: t }), "unknown_enrollment");
        await expectCode(deriveTermGrade(tx, { tenantId: TENANT_A, enrollmentId: ae.enrollments[0]!, termId: t }), "unknown_enrollment");
        await expectCode(deriveAnnualGrade(tx, { tenantId: TENANT_A, enrollmentId: e, academicYearId: NIL }), "unknown_academic_year");
        await expectCode(deriveAnnualGrade(tx, { tenantId: TENANT_A, enrollmentId: e, academicYearId: ae.yearId }), "unknown_academic_year");
        await expectCode(deriveAnnualGrade(tx, { tenantId: TENANT_A, enrollmentId: e, academicYearId: al.yearId }), "no_term_grades");
        expect(await tx.termGrade.count()).toBe(0);
        expect(await tx.annualGrade.count()).toBe(0);
      });
    },
    120_000,
  );
});
