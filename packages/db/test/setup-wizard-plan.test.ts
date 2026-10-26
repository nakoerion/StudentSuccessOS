/**
 * Setup wizard — the pure planning half (no database).
 */
import { AE, AL, type CountryPack } from "@ssos/country-packs";
import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_CATEGORIES,
  PLACEHOLDER_SUBJECTS,
  PLACEHOLDER_TERM_COUNT,
  planAcademicYear,
  splitIntoPeriods,
  type PlanInput,
} from "../src/setup-wizard";

const units = [
  { id: "u10", code: "10-A", name: "10-A", gradeLevel: 10 },
  { id: "u11", code: "11-A", name: "11-A", gradeLevel: 11 },
  { id: "x", code: "STAFF", name: "Staff room", gradeLevel: null },
];
const students = [
  { personId: "s1", unitId: "u10" },
  { personId: "s2", unitId: "u10" },
  { personId: "s3", unitId: "u11" },
];
const teachers = [{ personId: "t1" }, { personId: "t2" }, { personId: "t3" }];
const base = (pack: CountryPack, locale: PlanInput["locale"]): PlanInput => ({ pack, locale, units, students, teachers });

describe("setup wizard plan", () => {
  it("AL: pack has no terms -> two placeholder Period terms that tile the calendar year", () => {
    const plan = planAcademicYear(base(AL, "sq"));
    const cal = AL.examCalendars[0]!;
    expect(cal.terms).toHaveLength(0);
    expect(plan.academicYear).toEqual({ name: cal.academicYear, startsOn: cal.start, endsOn: cal.end });
    expect(plan.terms).toHaveLength(PLACEHOLDER_TERM_COUNT);
    expect(plan.terms.map((t) => t.key)).toEqual(["period-1", "period-2"]);
    expect(plan.terms[0]!.name).toBe("Periudha 1");
    expect(plan.terms[0]!.startsOn).toBe(cal.start);
    expect(plan.terms[1]!.endsOn).toBe(cal.end);
    // Contiguous: term 2 starts the day after term 1 ends.
    const next = new Date(`${plan.terms[0]!.endsOn}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(plan.terms[1]!.startsOn).toBe(next.toISOString().slice(0, 10));
    expect(plan.placeholders).toEqual(["terms", "subjects", "assessment_categories"]);
  });

  it("AE: the three real MOE 2026-27 terms straight from the pack calendar (golden), English names for an en tenant", () => {
    const plan = planAcademicYear(base(AE, "en"));
    expect(plan.academicYear).toEqual({ name: "2026-2027", startsOn: "2026-08-31", endsOn: "2027-07-02" });
    expect(plan.terms).toEqual([
      { key: "term-1", name: "Term 1", sequence: 1, startsOn: "2026-08-31", endsOn: "2026-12-11" },
      { key: "term-2", name: "Term 2", sequence: 2, startsOn: "2027-01-04", endsOn: "2027-04-02" },
      { key: "term-3", name: "Term 3", sequence: 3, startsOn: "2027-04-12", endsOn: "2027-07-02" },
    ]);
    expect(plan.placeholders).not.toContain("terms");
  });
  it("AE: an ar tenant (the pack default) gets the Arabic term names", () => {
    const plan = planAcademicYear(base(AE, "ar"));
    expect(plan.terms.map((t) => t.name)).toEqual(["الفصل الدراسي الأول", "الفصل الدراسي الثاني", "الفصل الدراسي الثالث"]);
    expect(plan.placeholders).toEqual(["subjects", "assessment_categories"]);
  });

  it("builds subject x grade courses, one section per class unit, enrollments and teacher round-robin", () => {
    const plan = planAcademicYear(base(AL, "sq"));
    const nSub = PLACEHOLDER_SUBJECTS.length;
    expect(plan.subjects).toHaveLength(nSub);
    expect(plan.subjects.every((s) => s.packCode === null && s.packKey === null)).toBe(true);
    expect(plan.subjects.find((s) => s.code === "MATH")!.name).toBe("Matematikë");
    expect(plan.skippedUnits).toEqual(["STAFF"]);
    expect(plan.courses).toHaveLength(nSub * 2);
    expect(plan.courses.find((c) => c.code === "MATH-10")).toMatchObject({ grade: "10", gradeScaleKey: "al-4-10" });
    expect(plan.sections).toHaveLength(nSub * 2);
    expect(plan.enrollments).toHaveLength(nSub * students.length);
    expect(plan.teacherAssignments).toHaveLength(nSub * 2);
    // Subject i is taught by teacher i mod n, in every grade.
    const mathTeachers = new Set(plan.teacherAssignments.filter((t) => t.courseCode.startsWith("MATH-")).map((t) => t.teacherPersonId));
    expect([...mathTeachers]).toEqual(["t1"]);
    expect(plan.categories).toHaveLength(nSub * 2 * PLACEHOLDER_CATEGORIES.length);
    for (const course of plan.courses) {
      const sum = plan.categories.filter((c) => c.courseCode === course.code).reduce((s, c) => s + c.weight, 0);
      expect(sum).toBe(100);
    }
  });

  it("uses pack subjects (with pack_code / pack_key) and pack default categories when the pack provides them", () => {
    const scale = AL.gradingScales[0]!;
    const pack: CountryPack = {
      ...AL,
      subjects: [
        { key: "matematike", code: "MAT", name: "Matematikë", nameEn: "Mathematics", sourceIds: [AL.sources[0]!.id] },
        { key: "fizike", code: "FIZ", name: "Fizikë", nameEn: "Physics", grades: ["11"], sourceIds: [AL.sources[0]!.id] },
      ],
      gradingScales: [
        {
          ...scale,
          defaultCategories: [
            { key: "oral", name: "Vlerësim me gojë", nameEn: "Oral", weight: 25 },
            { key: "written", name: "Me shkrim", nameEn: "Written", weight: 75 },
          ],
          categoriesSourceIds: [AL.sources[0]!.id],
        },
      ],
    };
    const plan = planAcademicYear(base(pack, "en"));
    expect(plan.subjects).toEqual([
      { code: "MAT", name: "Mathematics", packCode: "AL", packKey: "matematike" },
      { code: "FIZ", name: "Physics", packCode: "AL", packKey: "fizike" },
    ]);
    // FIZ is only taught in grade 11.
    expect(plan.courses.map((c) => c.code)).toEqual(["MAT-10", "MAT-11", "FIZ-11"]);
    expect(plan.categories.filter((c) => c.courseCode === "MAT-10")).toEqual([
      { courseCode: "MAT-10", name: "Oral", weight: 25 },
      { courseCode: "MAT-10", name: "Written", weight: 75 },
    ]);
    expect(plan.placeholders).toEqual(["terms"]);
  });

  it("is deterministic: the same input yields the same plan", () => {
    expect(planAcademicYear(base(AE, "ar"))).toEqual(planAcademicYear(base(AE, "ar")));
  });

  it("splitIntoPeriods tiles a range without gaps or overlaps", () => {
    expect(splitIntoPeriods("2026-09-01", "2026-09-10", 2)).toEqual([
      { startsOn: "2026-09-01", endsOn: "2026-09-05" },
      { startsOn: "2026-09-06", endsOn: "2026-09-10" },
    ]);
    expect(splitIntoPeriods("2026-09-01", "2026-09-03", 3).map((r) => r.startsOn)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
  });
});
