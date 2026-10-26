/**
 * Setup wizard against the live database.
 *
 * The seed runs the wizard for both demo tenants, so the golden cases read the
 * seeded year back THROUGH THE APP ROLE (ssos_app, RLS enforced). Re-runs and
 * from-scratch runs use the owner role inside a transaction that is rolled back,
 * so the shared database is left exactly as seeded.
 */
import { AE, AL } from "@ssos/country-packs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COUNTS, TENANTS } from "../seed/fixtures";
import {
  PLACEHOLDER_CATEGORIES,
  PLACEHOLDER_SUBJECTS,
  PLACEHOLDER_TERM_COUNT,
  runSetupWizard,
  WIZARD_TABLES,
  type SetupWizardResult,
  type WizardTable,
} from "../src/setup-wizard";
import { withTenant, type TenantTx } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

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

const SUBJECTS = PLACEHOLDER_SUBJECTS.length;
const GRADES = 3; // fixtures: one class unit per grade 10, 11, 12
const golden = (terms: number): Record<WizardTable, number> => ({
  academicYear: 1,
  term: terms,
  subject: SUBJECTS,
  course: SUBJECTS * GRADES,
  classSection: SUBJECTS * GRADES,
  enrollment: SUBJECTS * COUNTS.students, // every student takes every subject in their class
  teacherAssignment: SUBJECTS * GRADES,
  assessmentCategory: SUBJECTS * GRADES * PLACEHOLDER_CATEGORIES.length,
});

/** Per-table row counts as the APP role sees them inside one tenant. */
async function appCounts(tx: TenantTx): Promise<Record<WizardTable, number>> {
  return {
    academicYear: await tx.academicYear.count(),
    term: await tx.term.count(),
    subject: await tx.subject.count(),
    course: await tx.course.count(),
    classSection: await tx.classSection.count(),
    enrollment: await tx.enrollment.count(),
    teacherAssignment: await tx.teacherAssignment.count(),
    assessmentCategory: await tx.assessmentCategory.count(),
  };
}

/** Run the wizard as owner inside a transaction, capture results, roll back. */
async function ownerRolledBack<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await owner
    .$transaction(
      async (tx) => {
        out = await fn(tx);
        throw new Rollback();
      },
      { timeout: 120_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

describe("setup wizard: golden cases (seeded via the wizard, read through ssos_app)", () => {
  it("AL (Liceu Demo Tiranë): 1 year, 2 placeholder Period terms, full scaffolding", async () => {
    const cal = AL.examCalendars[0]!;
    const r = await withTenant(
      TENANT_A,
      async (tx) => ({
        counts: await appCounts(tx),
        year: await tx.academicYear.findFirstOrThrow(),
        terms: await tx.term.findMany({ orderBy: { sequence: "asc" } }),
        scales: await tx.course.findMany({ select: { gradeScale: { select: { key: true } } }, distinct: ["gradeScaleId"] }),
        enrollmentsPerStudent: await tx.enrollment.groupBy({ by: ["studentPersonId"], _count: { _all: true } }),
      }),
      { client: app },
    );
    expect(r.counts).toEqual(golden(PLACEHOLDER_TERM_COUNT));
    expect(r.year).toMatchObject({ name: cal.academicYear, isCurrent: true });
    expect(r.year.startsOn.toISOString().slice(0, 10)).toBe(cal.start);
    expect(r.year.endsOn.toISOString().slice(0, 10)).toBe(cal.end);
    expect(r.terms.map((t) => [t.key, t.name])).toEqual([
      ["period-1", "Periudha 1"],
      ["period-2", "Periudha 2"],
    ]);
    expect(r.terms[0]!.startsOn.toISOString().slice(0, 10)).toBe(cal.start);
    expect(r.terms[1]!.endsOn.toISOString().slice(0, 10)).toBe(cal.end);
    expect(r.scales.map((s) => s.gradeScale?.key)).toEqual(["al-4-10"]);
    expect(r.enrollmentsPerStudent).toHaveLength(COUNTS.students);
    expect(new Set(r.enrollmentsPerStudent.map((e) => e._count._all))).toEqual(new Set([SUBJECTS]));
  });

  it("AE (Demo School Abu Dhabi): 1 year, the pack's 3 terms, full scaffolding", async () => {
    const cal = AE.examCalendars[0]!;
    const r = await withTenant(
      TENANT_B,
      async (tx) => ({
        counts: await appCounts(tx),
        terms: await tx.term.findMany({ orderBy: { sequence: "asc" } }),
        subject: await tx.subject.findFirstOrThrow({ where: { code: "MATH" } }),
        weights: await tx.assessmentCategory.groupBy({ by: ["courseId"], _sum: { weight: true } }),
        scales: await tx.course.findMany({ select: { gradeScale: { select: { key: true } } }, distinct: ["gradeScaleId"] }),
      }),
      { client: app },
    );
    expect(r.counts).toEqual(golden(3));
    expect(r.terms.map((t) => ({ key: t.key, s: t.startsOn.toISOString().slice(0, 10), e: t.endsOn.toISOString().slice(0, 10) }))).toEqual(
      cal.terms.map((t) => ({ key: t.key, s: t.start, e: t.end })),
    );
    expect(r.subject).toMatchObject({ name: "Mathematics", packCode: null, packKey: null });
    expect(r.scales.map((s) => s.gradeScale?.key)).toEqual(["ae-moe-percentage"]);
    expect(r.weights).toHaveLength(SUBJECTS * GRADES);
    for (const w of r.weights) expect(Number(w._sum.weight)).toBe(100);
  });

  it("every teacher_assignment points at a seeded teacher, one primary per section", async () => {
    const r = await withTenant(
      TENANT_A,
      async (tx) => ({
        tas: await tx.teacherAssignment.findMany({ select: { classSectionId: true, teacherPersonId: true, role: true } }),
        teachers: await tx.roleAssignment.findMany({ where: { role: { key: "teacher" } }, select: { personId: true } }),
      }),
      { client: app },
    );
    const teacherIds = new Set(r.teachers.map((t) => t.personId));
    expect(r.tas.every((t) => t.classSectionId !== null && t.role === "primary" && teacherIds.has(t.teacherPersonId))).toBe(true);
    expect(new Set(r.tas.map((t) => t.classSectionId)).size).toBe(r.tas.length);
  });
});

describe("setup wizard: idempotency", () => {
  for (const [label, tenantId, terms] of [
    ["AL", TENANT_A, PLACEHOLDER_TERM_COUNT],
    ["AE", TENANT_B, 3],
  ] as const) {
    it(`${label}: re-running on the seeded tenant inserts nothing and leaves identical counts`, async () => {
      const before = await withTenant(tenantId, appCounts, { client: app });
      const r = await ownerRolledBack(async (tx) => {
        const first = await runSetupWizard(tx, { tenantId });
        const second = await runSetupWizard(tx, { tenantId });
        return { first, second };
      });
      const zero = Object.fromEntries(WIZARD_TABLES.map((t) => [t, 0]));
      expect(r.first.created).toEqual(zero);
      expect(r.second.created).toEqual(zero);
      expect(r.first.totals).toEqual(golden(terms));
      expect(r.second.totals).toEqual(r.first.totals);
      expect(await withTenant(tenantId, appCounts, { client: app })).toEqual(before);
    });

    it(`${label}: from an empty academic record, run 1 creates the golden year and run 2 creates nothing`, async () => {
      const r = await ownerRolledBack(async (tx) => {
        await tx.academicYear.deleteMany({ where: { tenantId } }); // cascades to term/course/section/enrollment/...
        await tx.subject.deleteMany({ where: { tenantId } });
        const first: SetupWizardResult = await runSetupWizard(tx, { tenantId });
        const second: SetupWizardResult = await runSetupWizard(tx, { tenantId });
        const counts = {
          years: await tx.academicYear.count({ where: { tenantId } }),
          enrollments: await tx.enrollment.count({ where: { tenantId } }),
          termGrades: await tx.termGrade.count({ where: { tenantId } }),
          annualGrades: await tx.annualGrade.count({ where: { tenantId } }),
          events: await tx.event.count({ where: { tenantId } }),
        };
        return { first, second, counts };
      });
      expect(r.first.created).toEqual(golden(terms));
      expect(r.second.created).toEqual(Object.fromEntries(WIZARD_TABLES.map((t) => [t, 0])));
      expect(r.second.totals).toEqual(r.first.totals);
      expect(r.counts.years).toBe(1);
      expect(r.counts.enrollments).toBe(golden(terms).enrollment);
      // Derived and append-only tables are never written by the wizard.
      expect(r.counts.termGrades).toBe(0);
      expect(r.counts.annualGrades).toBe(0);
      expect(r.counts.events).toBe(0);
    });
  }

  it("reports the placeholder data it had to use (AL: terms, subjects, categories; AE: subjects, categories)", async () => {
    const r = await ownerRolledBack(async (tx) => ({
      al: await runSetupWizard(tx, { tenantId: TENANT_A }),
      ae: await runSetupWizard(tx, { tenantId: TENANT_B }),
    }));
    expect(r.al.placeholders).toEqual(["terms", "subjects", "assessment_categories"]);
    expect(r.ae.placeholders).toEqual(["subjects", "assessment_categories"]);
    expect(r.al.packCode).toBe(TENANTS[0]!.countryCode);
    expect(r.ae.packCode).toBe(TENANTS[1]!.countryCode);
  });
});

describe("setup wizard: tenant isolation through ssos_app", () => {
  for (const [label, self, other] of [
    ["A -> B", TENANT_A, TENANT_B],
    ["B -> A", TENANT_B, TENANT_A],
  ] as const) {
    it(`${label}: the other tenant's wizard output is invisible, by scan and by id`, async () => {
      const otherIds = {
        course: (await owner.course.findMany({ where: { tenantId: other }, select: { id: true } })).map((r) => r.id),
        classSection: (await owner.classSection.findMany({ where: { tenantId: other }, select: { id: true } })).map((r) => r.id),
        enrollment: (await owner.enrollment.findMany({ where: { tenantId: other }, select: { id: true } })).map((r) => r.id),
        teacherAssignment: (await owner.teacherAssignment.findMany({ where: { tenantId: other }, select: { id: true } })).map((r) => r.id),
        assessmentCategory: (await owner.assessmentCategory.findMany({ where: { tenantId: other }, select: { id: true } })).map((r) => r.id),
      };
      expect(otherIds.enrollment.length).toBeGreaterThan(0);
      const seen = await withTenant(
        self,
        async (tx) => ({
          byId:
            (await tx.course.count({ where: { id: { in: otherIds.course } } })) +
            (await tx.classSection.count({ where: { id: { in: otherIds.classSection } } })) +
            (await tx.enrollment.count({ where: { id: { in: otherIds.enrollment } } })) +
            (await tx.teacherAssignment.count({ where: { id: { in: otherIds.teacherAssignment } } })) +
            (await tx.assessmentCategory.count({ where: { id: { in: otherIds.assessmentCategory } } })),
          byTenant:
            (await tx.course.count({ where: { tenantId: other } })) +
            (await tx.enrollment.count({ where: { tenantId: other } })) +
            (await tx.assessmentCategory.count({ where: { tenantId: other } })),
          tenants: new Set([
            ...(await tx.course.findMany({ select: { tenantId: true } })).map((r) => r.tenantId),
            ...(await tx.enrollment.findMany({ select: { tenantId: true } })).map((r) => r.tenantId),
            ...(await tx.teacherAssignment.findMany({ select: { tenantId: true } })).map((r) => r.tenantId),
          ]),
          updated: (await tx.assessmentCategory.updateMany({ where: { id: { in: otherIds.assessmentCategory } }, data: { weight: 0 } })).count,
        }),
        { client: app },
      );
      expect(seen.byId).toBe(0);
      expect(seen.byTenant).toBe(0);
      expect(seen.tenants).toEqual(new Set([self]));
      expect(seen.updated).toBe(0);
    });
  }

  it("without a tenant context the app role sees none of the wizard's rows", async () => {
    const r = await app.$transaction(async (tx) => ({
      courses: await tx.course.count(),
      enrollments: await tx.enrollment.count(),
    }));
    expect(r).toEqual({ courses: 0, enrollments: 0 });
  });
});
