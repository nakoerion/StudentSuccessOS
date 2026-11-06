/**
 * Risk model (success engine slice 2): the pure scoring (contributions sum exactly to the
 * score, renormalisation over the factors with data, top-4 vs cohort baseline, bands),
 * and the services against the live DB — single-student recompute touches only that
 * student, tenant recompute, and a new weights version triggers a tenant recompute.
 *
 * DB cases run as the owner inside a transaction that is rolled back, so the shared
 * database is left exactly as seeded. The one RLS read case commits and cleans up.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  apportion,
  bandFor,
  computeRiskScore,
  getLatestRiskScore,
  parseBandThresholds,
  parseRiskWeights,
  recomputeStudentRisk,
  recomputeTenantRisk,
  RiskModelError,
  type RiskModelErrorCode,
  type RiskValues,
  signalToRisk,
  writeRiskModelConfig,
} from "../src/risk-model";
import { DEFAULT_BAND_THRESHOLDS, DEFAULT_RISK_WEIGHTS, RISK_FACTORS, type RiskFactor } from "../src/success-defaults";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

const D = (v: number | string) => new Prisma.Decimal(v);
const cents = (n: number) => Math.round(n * 100);
const sumCents = (xs: number[]) => xs.reduce((a, x) => a + cents(x), 0);

function risks(partial: Partial<Record<RiskFactor, number>>): RiskValues {
  return Object.fromEntries(RISK_FACTORS.map((f) => [f, partial[f] === undefined ? null : D(partial[f])])) as RiskValues;
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: RiskModelErrorCode) {
  let err: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RiskModelError);
  expect((err as RiskModelError).code).toBe(code);
}

// ─── Pure ─────────────────────────────────────────────────────────────────────

describe("risk model: pure scoring", () => {
  it("factor contributions sum EXACTLY to the score (2 000 random students, awkward weights)", () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const weights = Object.fromEntries(RISK_FACTORS.map((f) => [f, rnd() < 0.15 ? 0 : Math.round(rnd() * 1000) / 7])) as Record<RiskFactor, number>;
      weights.gradeLevel = Math.max(weights.gradeLevel, 1 / 3);
      const r = risks(Object.fromEntries(RISK_FACTORS.filter(() => rnd() < 0.7).map((f) => [f, Math.round(rnd() * 10000) / 100])));
      r.gradeLevel = D(Math.round(rnd() * 10000) / 100);
      const out = computeRiskScore({ risks: r, weights, thresholds: DEFAULT_BAND_THRESHOLDS })!;
      expect(out).not.toBeNull();
      expect(sumCents(out.factors.map((f) => f.contribution))).toBe(cents(out.score));
      expect(out.score).toBeGreaterThanOrEqual(0);
      expect(out.score).toBeLessThanOrEqual(100);
      for (const f of out.factors) expect(Number.isInteger(Math.round(f.contribution * 100))).toBe(true);
    }
  });

  it("thirds that do not divide evenly still sum exactly (largest remainder)", () => {
    const out = computeRiskScore({
      risks: risks({ gradeLevel: 10, attendanceLevel: 10, lateMissing: 13.33 }),
      weights: { ...DEFAULT_RISK_WEIGHTS, gradeLevel: 1, attendanceLevel: 1, lateMissing: 1 },
      thresholds: DEFAULT_BAND_THRESHOLDS,
    })!;
    // (10 + 10 + 13.33) / 3 = 11.11; parts 3.333.., 3.333.., 4.443..
    expect(out.score).toBe(11.11);
    expect(sumCents(out.factors.map((f) => f.contribution))).toBe(1111);
    expect(apportion([D("3.335"), D("3.335"), D("3.33")], D("10")).map((d) => d.toNumber())).toEqual([3.34, 3.33, 3.33]);
  });

  it("renormalises over the factors WITH data instead of scoring missing ones as zero", () => {
    // Only grade level (w 0.25) and attendance level (w 0.20) have data.
    const out = computeRiskScore({ risks: risks({ gradeLevel: 40, attendanceLevel: 80 }), weights: DEFAULT_RISK_WEIGHTS, thresholds: DEFAULT_BAND_THRESHOLDS })!;
    // 40 × 0.25/0.45 + 80 × 0.20/0.45 = 22.222… + 35.555… = 57.78
    expect(out.score).toBe(57.78);
    expect(out.band).toBe("high");
    const by = Object.fromEntries(out.factors.map((f) => [f.factor, f]));
    expect(by.gradeLevel!.effectiveWeight).toBeCloseTo(0.555556, 6);
    expect(by.attendanceLevel!.effectiveWeight).toBeCloseTo(0.444444, 6);
    expect(by.gradeLevel!.contribution + by.attendanceLevel!.contribution).toBeCloseTo(57.78, 10);
    for (const f of ["gradeTrend", "attendanceTrend", "lateMissing", "engagement", "concernNotes"] as const) {
      expect(by[f]!.available).toBe(false);
      expect(by[f]!.contribution).toBe(0);
      expect(by[f]!.effectiveWeight).toBe(0);
      expect(by[f]!.rank).toBeNull();
    }
    // Scoring missing factors as 0 would have given 40×0.25 + 80×0.2 = 26 (band low) — not what we store.
    expect(out.score).not.toBe(26);
  });

  it("no factor with data (or only zero-weight ones) -> not scored", () => {
    expect(computeRiskScore({ risks: risks({}), weights: DEFAULT_RISK_WEIGHTS, thresholds: DEFAULT_BAND_THRESHOLDS })).toBeNull();
    expect(
      computeRiskScore({ risks: risks({ engagement: 90 }), weights: { ...DEFAULT_RISK_WEIGHTS, engagement: 0 }, thresholds: DEFAULT_BAND_THRESHOLDS }),
    ).toBeNull();
  });

  it("ranks the top-4 factors by points above the grade-cohort baseline", () => {
    const weights = { gradeLevel: 1, gradeTrend: 1, attendanceLevel: 1, attendanceTrend: 1, lateMissing: 1, engagement: 0, concernNotes: 1 };
    const out = computeRiskScore({
      risks: risks({ gradeLevel: 50, gradeTrend: 10, attendanceLevel: 60, attendanceTrend: 0, lateMissing: 30, concernNotes: 40 }),
      weights,
      thresholds: DEFAULT_BAND_THRESHOLDS,
      // gradeLevel is high but so is the cohort's; concern notes are unusual for this cohort.
      baseline: { gradeLevel: 48, gradeTrend: 5, attendanceLevel: 20, attendanceTrend: 0, lateMissing: 30, concernNotes: 0 },
    })!;
    expect(out.topFactors).toEqual(["attendanceLevel", "concernNotes", "gradeTrend", "gradeLevel"]);
    expect(out.factors.filter((f) => f.top).map((f) => f.factor)).toEqual(out.topFactors);
    const att = out.factors.find((f) => f.factor === "attendanceLevel")!;
    expect(att.baseline).toBe(20);
    expect(att.vsBaseline).toBeCloseTo((60 - 20) / 6, 2);
    expect(att.rank).toBe(1);
    expect(out.factors.find((f) => f.factor === "engagement")!.available).toBe(false);
  });

  it("bands come from the configured thresholds (score >= cut-off)", () => {
    const t = { moderate: 30, high: 55, critical: 75 };
    expect([0, 29.99, 30, 54.99, 55, 74.99, 75, 100].map((s) => bandFor(s, t))).toEqual([
      "low",
      "low",
      "moderate",
      "moderate",
      "high",
      "high",
      "critical",
      "critical",
    ]);
    expect(bandFor(50, { moderate: 10, high: 20, critical: 50 })).toBe("critical");
  });

  it("maps signals to 0–100 risks with the documented linear rules", () => {
    expect(signalToRisk("gradeLevel", 72.5).toNumber()).toBe(27.5);
    expect(signalToRisk("gradeTrend", -10).toNumber()).toBe(50);
    expect(signalToRisk("gradeTrend", 15).toNumber()).toBe(0);
    expect(signalToRisk("attendanceLevel", 90).toNumber()).toBe(40);
    expect(signalToRisk("attendanceLevel", 50).toNumber()).toBe(100);
    expect(signalToRisk("attendanceTrend", -5).toNumber()).toBe(25);
    expect(signalToRisk("lateMissing", 0.25).toNumber()).toBe(25);
    expect(signalToRisk("concernNotes", 2).toNumber()).toBe(40);
    expect(signalToRisk("concernNotes", 9).toNumber()).toBe(100);
  });

  it("validates weights and thresholds", async () => {
    await expectCode(() => parseRiskWeights({ gradeLevel: 1, shoeSize: 2 }), "invalid_weights");
    await expectCode(() => parseRiskWeights({ gradeLevel: -1 }), "invalid_weights");
    await expectCode(() => parseRiskWeights({ gradeLevel: 0 }), "invalid_weights");
    await expectCode(() => parseRiskWeights([1, 2]), "invalid_weights");
    expect(parseRiskWeights({ gradeLevel: 2 })).toEqual({ ...Object.fromEntries(RISK_FACTORS.map((f) => [f, 0])), gradeLevel: 2 });
    await expectCode(() => parseBandThresholds({ moderate: 50, high: 40, critical: 75 }), "invalid_thresholds");
    await expectCode(() => parseBandThresholds({ moderate: 10, high: 40, critical: 101 }), "invalid_thresholds");
    expect(parseBandThresholds(DEFAULT_BAND_THRESHOLDS)).toEqual(DEFAULT_BAND_THRESHOLDS);
  });
});

// ─── Database ─────────────────────────────────────────────────────────────────

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

type Tx = Prisma.TransactionClient;

async function ownerRolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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

const AS_OF = new Date("2026-12-10T12:00:00Z");

interface CohortFx {
  grade: string;
  /** Students of the cohort (same course.grade), first three get data below. */
  students: string[];
  /** Per student: [{ enrollmentId, categoryId, termId, scaleId, scaleMax }] for their courses. */
  courses: Map<string, { enrollmentId: string; categoryId: string; termId: string; scaleId: string; scaleMax: number }[]>;
}

/** A seeded grade cohort of a tenant: its students and, per student, one category per course. */
async function cohort(tx: Tx, tenantId: string, grade = "10"): Promise<CohortFx> {
  const term = await tx.term.findFirstOrThrow({ where: { tenantId, startsOn: { lte: AS_OF }, endsOn: { gte: AS_OF } } });
  const rows = await tx.enrollment.findMany({
    where: { tenantId, status: "active", classSection: { course: { grade, academicYearId: term.academicYearId } } },
    select: {
      id: true,
      studentPersonId: true,
      classSection: { select: { course: { select: { gradeScale: { select: { id: true, maxValue: true } }, assessmentCategories: { select: { id: true }, orderBy: { name: "asc" }, take: 1 } } } } },
    },
    orderBy: [{ studentPersonId: "asc" }, { id: "asc" }],
  });
  const courses: CohortFx["courses"] = new Map();
  for (const r of rows) {
    const c = r.classSection.course;
    courses.set(r.studentPersonId, [
      ...(courses.get(r.studentPersonId) ?? []),
      { enrollmentId: r.id, categoryId: c.assessmentCategories[0]!.id, termId: term.id, scaleId: c.gradeScale!.id, scaleMax: c.gradeScale!.maxValue.toNumber() },
    ]);
  }
  return { grade, students: [...courses.keys()], courses };
}

/** Grade entries at given percentages (chronological, 1 day apart from 2026-11-01) in the student's first course. */
async function addGrades(tx: Tx, tenantId: string, fx: CohortFx, student: string, pcts: number[]) {
  const c = fx.courses.get(student)![0]!;
  await tx.gradeEntry.createMany({
    data: pcts.map((p, i) => ({
      tenantId,
      enrollmentId: c.enrollmentId,
      assessmentCategoryId: c.categoryId,
      termId: c.termId,
      gradeScaleId: c.scaleId,
      rawMark: D(p).mul(c.scaleMax).div(100).toDecimalPlaces(2),
      gradedAt: new Date(Date.UTC(2026, 10, 1 + i, 9)),
    })),
  });
}

/** Attendance marks (one per day from 2026-11-16) in the student's first course. */
async function addAttendance(tx: Tx, tenantId: string, fx: CohortFx, student: string, statuses: ("present" | "absent" | "late" | "excused")[]) {
  const c = fx.courses.get(student)![0]!;
  await tx.attendanceEvent.createMany({
    data: statuses.map((status, i) => ({ tenantId, enrollmentId: c.enrollmentId, studentPersonId: student, date: new Date(Date.UTC(2026, 10, 16 + i)), status })),
  });
}

const rowsFor = (tx: Tx, tenantId: string) =>
  tx.riskScore.findMany({ where: { tenantId }, select: { id: true, studentPersonId: true, modelVersion: true, score: true, factors: true } });

describe("risk model: recomputeStudentRisk", () => {
  it("writes exactly one row, for the affected student only; contributions sum to the stored score", async () => {
    const r = await ownerRolledBack(async (tx) => {
      const fx = await cohort(tx, TENANT_A);
      const [s1, s2, s3] = fx.students as [string, string, string];
      await addGrades(tx, TENANT_A, fx, s1, [80, 70, 50, 40]); // falling: trend −30 pts
      await addGrades(tx, TENANT_A, fx, s2, [90, 90]);
      await addGrades(tx, TENANT_A, fx, s3, [60]);
      await addAttendance(tx, TENANT_A, fx, s1, ["present", "absent", "absent", "late"]);
      const before = await rowsFor(tx, TENANT_A);
      const res = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: s1, asOf: AS_OF });
      const after = await rowsFor(tx, TENANT_A);
      const other = await recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.students[5]!, asOf: AS_OF });
      return { s1, s2, s3, fx, before, after, res, other, afterOther: await rowsFor(tx, TENANT_A) };
    });
    expect(r.res.status).toBe("scored");
    if (r.res.status !== "scored") return;
    const added = r.after.filter((a) => !r.before.some((b) => b.id === a.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.studentPersonId).toBe(r.s1);
    expect(r.after).toHaveLength(r.before.length + 1);

    const v = r.res.riskScore;
    expect(v.studentPersonId).toBe(r.s1);
    expect(v.modelVersion).toBe(1);
    expect(sumCents(v.factors.map((f) => f.contribution))).toBe(cents(v.score));
    const by = Object.fromEntries(v.factors.map((f) => [f.factor, f]));
    // gradeLevel: mean 60% -> risk 40; trend: (50+40)/2 − (80+70)/2 = −30 -> risk 100 (capped).
    expect(by.gradeLevel).toMatchObject({ available: true, value: 60, risk: 40 });
    expect(by.gradeTrend).toMatchObject({ available: true, value: -30, risk: 100 });
    // attendance: 2 of 4 attended = 50% -> risk 100; trend needs both 30-day windows -> none.
    expect(by.attendanceLevel).toMatchObject({ available: true, value: 50, risk: 100 });
    for (const f of ["attendanceTrend", "lateMissing", "engagement", "concernNotes"]) expect(by[f]!.available).toBe(false);
    // Renormalised over 0.25 + 0.15 + 0.20 = 0.60: (40×0.25 + 100×0.15 + 100×0.20) / 0.6 = 75.
    expect(v.score).toBe(75);
    expect(v.band).toBe("critical");
    // Cohort baseline: grade 10, gradeLevel risks 40 (s1), 10 (s2), 40 (s3) -> mean 30.
    expect(v.cohortBaseline).toMatchObject({ grade: "10", cohortSize: r.fx.students.length, scoredCohortSize: 3 });
    expect(v.cohortBaseline.factors.gradeLevel).toBe(30);
    expect(by.gradeLevel!.baseline).toBe(30);
    expect(v.factors.filter((f) => f.top).length).toBe(3);
    // A classmate without any data is not scored and nothing is written for them.
    expect(r.other.status).toBe("insufficient_data");
    expect(r.afterOther).toHaveLength(r.after.length);
  });

  it("rejects unknown and un-enrolled students; needs an active config", async () => {
    await expectCode(recomputeStudentRisk(owner, { tenantId: TENANT_A, studentPersonId: "00000000-0000-4000-8000-000000000000" }), "unknown_student");
    const bStudent = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B, externalRef: "S-001" } });
    await expectCode(recomputeStudentRisk(owner, { tenantId: TENANT_A, studentPersonId: bStudent.id }), "unknown_student");
    const teacher = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A, externalRef: { startsWith: "T-" } } });
    await expectCode(recomputeStudentRisk(owner, { tenantId: TENANT_A, studentPersonId: teacher.id }), "not_enrolled");
    await ownerRolledBack(async (tx) => {
      await tx.riskModelConfig.updateMany({ where: { tenantId: TENANT_A }, data: { isActive: false } });
      const fx = await cohort(tx, TENANT_A);
      await expectCode(recomputeStudentRisk(tx, { tenantId: TENANT_A, studentPersonId: fx.students[0]! }), "no_active_config");
    });
  });

  it("late/missing submissions and concern notes are scored once their sources have data", async () => {
    const v = await ownerRolledBack(async (tx) => {
      const fx = await cohort(tx, TENANT_B);
      const s = fx.students[0]!;
      await addGrades(tx, TENANT_B, fx, s, [70]);
      const enr = await tx.enrollment.findFirstOrThrow({ where: { id: fx.courses.get(s)![0]!.enrollmentId }, select: { classSectionId: true } });
      const due = new Date("2026-12-01T12:00:00Z");
      const [a1, a2, a3, a4] = await Promise.all(
        [1, 2, 3, 4].map((i) => tx.assignment.create({ data: { tenantId: TENANT_B, classSectionId: enr.classSectionId, title: `Probe ${i}`, dueAt: due, publishedAt: due } })),
      );
      // a1 on time, a2 late, a3 draft only (= missing), a4 nothing (= missing) -> 3/4 late or missing.
      await tx.submission.createMany({
        data: [
          { tenantId: TENANT_B, assignmentId: a1!.id, studentPersonId: s, status: "submitted", submittedAt: due },
          { tenantId: TENANT_B, assignmentId: a2!.id, studentPersonId: s, status: "submitted", submittedAt: AS_OF, isLate: true },
          { tenantId: TENANT_B, assignmentId: a3!.id, studentPersonId: s, status: "draft" },
        ],
      });
      void a4;
      await tx.note.create({ data: { tenantId: TENANT_B, subjectPersonId: s, body: "Seemed withdrawn in class", visibility: "internal", createdAt: new Date("2026-12-05T10:00:00Z") } });
      const res = await recomputeStudentRisk(tx, { tenantId: TENANT_B, studentPersonId: s, asOf: AS_OF });
      return res.status === "scored" ? res.riskScore : null;
    });
    expect(v).not.toBeNull();
    const by = Object.fromEntries(v!.factors.map((f) => [f.factor, f]));
    expect(by.lateMissing).toMatchObject({ available: true, value: 0.75, risk: 75 });
    expect(by.concernNotes).toMatchObject({ available: true, value: 1, risk: 20 });
    expect(by.engagement!.available).toBe(false);
    // (30×0.25 + 75×0.15 + 20×0.10) / 0.50 = 41.5
    expect(v!.score).toBe(41.5);
    expect(v!.band).toBe("moderate");
    expect(sumCents(v!.factors.map((f) => f.contribution))).toBe(cents(v!.score));
  });
});

describe("risk model: recomputeTenantRisk and weight changes", () => {
  it("tenant recompute writes one row per scorable student and none for students without data", async () => {
    const r = await ownerRolledBack(async (tx) => {
      const fx10 = await cohort(tx, TENANT_A, "10");
      const fx11 = await cohort(tx, TENANT_A, "11");
      await addGrades(tx, TENANT_A, fx10, fx10.students[0]!, [55, 65]);
      await addGrades(tx, TENANT_A, fx10, fx10.students[1]!, [85]);
      await addAttendance(tx, TENANT_A, fx11, fx11.students[0]!, ["present", "present", "absent"]);
      const before = await rowsFor(tx, TENANT_A);
      const res = await recomputeTenantRisk(tx, { tenantId: TENANT_A, asOf: AS_OF });
      return { res, before, after: await rowsFor(tx, TENANT_A), students: await tx.enrollment.groupBy({ by: ["studentPersonId"], where: { tenantId: TENANT_A, status: "active" } }) };
    });
    expect(r.res.students).toBe(r.students.length);
    expect(r.res.scored).toBe(3);
    expect(r.res.insufficientData).toBe(r.students.length - 3);
    const added = r.after.filter((a) => !r.before.some((b) => b.id === a.id));
    expect(added).toHaveLength(3);
    for (const row of added) {
      const factors = row.factors as { contribution: number }[];
      expect(sumCents(factors.map((f) => f.contribution))).toBe(cents(row.score.toNumber()));
    }
  });

  it("a new weights version is activated, logged as one event and triggers a full tenant recompute", async () => {
    const r = await ownerRolledBack(async (tx) => {
      const fx = await cohort(tx, TENANT_A);
      const [s1, s2] = fx.students as [string, string];
      await addGrades(tx, TENANT_A, fx, s1, [80, 70, 50, 40]);
      await addGrades(tx, TENANT_A, fx, s2, [90]);
      await addAttendance(tx, TENANT_A, fx, s2, ["present", "absent"]);
      const v1 = await recomputeTenantRisk(tx, { tenantId: TENANT_A, asOf: AS_OF });
      const v1Rows = await rowsFor(tx, TENANT_A);
      const eventsBefore = await tx.event.count({ where: { tenantId: TENANT_A, type: "risk_model_config.activated" } });
      const admin = await tx.person.findFirstOrThrow({ where: { tenantId: TENANT_A, externalRef: { startsWith: "T-" } } });
      const written = await writeRiskModelConfig(tx, {
        tenantId: TENANT_A,
        weights: { gradeLevel: 1, attendanceLevel: 3 },
        note: "Attendance first",
        actorPersonId: admin.id,
        asOf: AS_OF,
      });
      return {
        s1,
        s2,
        v1,
        v1Rows,
        written,
        configs: await tx.riskModelConfig.findMany({ where: { tenantId: TENANT_A }, orderBy: { version: "asc" } }),
        events: await tx.event.findMany({ where: { tenantId: TENANT_A, type: "risk_model_config.activated" } }),
        eventsBefore,
        latest1: await getLatestRiskScore(tx, TENANT_A, s1),
        latest2: await getLatestRiskScore(tx, TENANT_A, s2),
        rows: await rowsFor(tx, TENANT_A),
      };
    });
    const { written } = r;
    expect(written.config.version).toBe(2);
    expect(written.config.previousVersion).toBe(1);
    expect(r.configs.map((c) => [c.version, c.isActive])).toEqual([
      [1, false],
      [2, true],
    ]);
    // Thresholds are inherited from v1 when not given.
    expect(r.configs[1]!.bandThresholds).toEqual(DEFAULT_BAND_THRESHOLDS);
    expect(r.events.length).toBe(r.eventsBefore + 1);
    expect(r.events.at(-1)!.payload).toMatchObject({ version: 2, previousVersion: 1 });

    // The recompute covered the whole tenant with the new version.
    expect(written.recompute.modelVersion).toBe(2);
    expect(written.recompute.scored).toBe(r.v1.scored);
    expect(written.recompute.scored).toBe(2);
    const v2Rows = r.rows.filter((x) => x.modelVersion === 2);
    expect(v2Rows.map((x) => x.studentPersonId).sort()).toEqual([r.s1, r.s2].sort());
    expect(r.rows.length).toBe(r.v1Rows.length + 2);

    // s1 has only grades: weights over {gradeLevel} only -> score = gradeLevel risk = 40.
    expect(r.latest1!.modelVersion).toBe(2);
    expect(r.latest1!.score).toBe(40);
    // s2: gradeLevel risk 10, attendance 50% -> risk 100; (10×1 + 100×3)/4 = 77.5.
    expect(r.latest2!.score).toBe(77.5);
    expect(r.latest2!.band).toBe("critical");
    for (const v of [r.latest1!, r.latest2!]) expect(sumCents(v.factors.map((f) => f.contribution))).toBe(cents(v.score));
  });

  it("rejects invalid weights and thresholds without writing anything", async () => {
    const before = await owner.riskModelConfig.count({ where: { tenantId: TENANT_A } });
    await expectCode(writeRiskModelConfig(owner, { tenantId: TENANT_A, weights: { gradeLevel: -1 } }), "invalid_weights");
    await expectCode(writeRiskModelConfig(owner, { tenantId: TENANT_A, weights: { gradeLevel: 1 }, bandThresholds: { moderate: 60, high: 50, critical: 70 } }), "invalid_thresholds");
    await expectCode(writeRiskModelConfig(owner, { tenantId: TENANT_A, weights: { gradeLevel: 1 }, actorPersonId: "00000000-0000-4000-8000-000000000000" }), "unknown_actor");
    expect(await owner.riskModelConfig.count({ where: { tenantId: TENANT_A } })).toBe(before);
  });
});

describe("risk model: risk_score is engine-owned", () => {
  it("the app role reads scores through RLS but can neither insert nor update them", async () => {
    const config = await owner.riskModelConfig.findFirstOrThrow({ where: { tenantId: TENANT_B, isActive: true } });
    const fxStudent = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B, externalRef: "S-002" } });
    // Commit one engine-written row, read it as the app, then remove it.
    const enr = await owner.enrollment.findFirstOrThrow({
      where: { tenantId: TENANT_B, studentPersonId: fxStudent.id },
      select: { id: true, classSection: { select: { course: { select: { gradeScaleId: true, assessmentCategories: { select: { id: true }, take: 1 } } } } } },
    });
    const term = await owner.term.findFirstOrThrow({ where: { tenantId: TENANT_B, startsOn: { lte: AS_OF }, endsOn: { gte: AS_OF } } });
    const entry = await owner.gradeEntry.create({
      data: {
        tenantId: TENANT_B,
        enrollmentId: enr.id,
        assessmentCategoryId: enr.classSection.course.assessmentCategories[0]!.id,
        termId: term.id,
        gradeScaleId: enr.classSection.course.gradeScaleId!,
        rawMark: D(50),
        gradedAt: new Date("2026-11-20T09:00:00Z"),
      },
    });
    let scoreId: string | null = null;
    try {
      const res = await recomputeStudentRisk(owner, { tenantId: TENANT_B, studentPersonId: fxStudent.id, asOf: AS_OF });
      expect(res.status).toBe("scored");
      if (res.status === "scored") scoreId = res.riskScore.id;
      const seen = await withTenant(TENANT_B, (tx) => getLatestRiskScore(tx, TENANT_B, fxStudent.id), { client: app });
      expect(seen?.id).toBe(scoreId);
      expect(await withTenant(TENANT_A, (tx) => getLatestRiskScore(tx, TENANT_B, fxStudent.id), { client: app })).toBeNull();

      await expect(
        withTenant(
          TENANT_B,
          (tx) => tx.riskScore.create({ data: { tenantId: TENANT_B, studentPersonId: fxStudent.id, modelConfigId: config.id, modelVersion: config.version, score: "1.00", band: "low" } }),
          { client: app },
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        withTenant(TENANT_B, (tx) => tx.$executeRawUnsafe(`UPDATE "risk_score" SET score = 0 WHERE id = $1::uuid`, scoreId), { client: app }),
      ).rejects.toThrow(/permission denied/i);
      // An engine call on the app role fails the same way (it must run as the owner).
      await expect(
        withTenant(TENANT_B, (tx) => recomputeStudentRisk(tx, { tenantId: TENANT_B, studentPersonId: fxStudent.id, asOf: AS_OF }), { client: app }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      if (scoreId) await owner.riskScore.deleteMany({ where: { id: scoreId } });
      await owner.gradeEntry.delete({ where: { id: entry.id } });
    }
  });

  it("the app role's grant on risk_score is SELECT only", async () => {
    const rows = await owner.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'ssos_app' AND table_name = 'risk_score' ORDER BY 1`;
    expect(rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
  });
});
