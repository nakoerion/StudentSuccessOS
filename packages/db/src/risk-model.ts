/**
 * Risk model (success engine slice 2). Service layer only.
 *
 * A transparent weighted score 0–100 per student, from the tenant's ACTIVE
 * `risk_model_config` (versioned weights + band thresholds):
 *
 *   1. Signals. For every factor the model reads a raw signal from the academic record
 *      of the current academic year, up to `asOf`:
 *        gradeLevel       mean grade-entry percentage (mean per enrollment, then across
 *                         enrollments, so every course counts equally);
 *        gradeTrend       mean % of the most recent half of the entries minus the
 *                         earlier half (needs >= 4 entries; percentage points);
 *        attendanceLevel  present rate = (present + late) / all marks × 100 — the same
 *                         formula as the attendance_rate view;
 *        attendanceTrend  present rate of the last 30 days minus the 30 days before;
 *        lateMissing      share of published, past-due assignments of the student's
 *                         sections that were handed in late or not at all;
 *        engagement       no source in the academic record yet — always "no data";
 *        concernNotes     staff-only (`internal`) notes about the student, last 30 days —
 *                         "no data" until the tenant has written any note at all.
 *   2. Risk per factor, 0–100 (higher = more risk), rounded half-up to 2 dp — the
 *      linear maps are in RISK_SIGNAL_RULES, identical for every tenant and country.
 *   3. Renormalisation. Only factors WITH data are scored: their configured weights are
 *      divided by the sum of the available weights (effectiveWeight), so a factor with no
 *      data (e.g. submissions before the assignments slice) never scores as zero risk.
 *      A student with no data at all is not scored ("insufficient_data").
 *   4. score = Σ effectiveWeight × risk, rounded half-up to 2 dp. Each factor's
 *      contribution is its exact share, rounded to 2 dp with largest-remainder
 *      apportionment, so the stored contributions sum EXACTLY to the stored score.
 *   5. Cohort baseline: the mean risk per factor over the student's grade cohort
 *      (students whose current-year courses carry the same `course.grade`), plus the mean
 *      cohort score. vsBaseline = effectiveWeight × (risk − baseline): how many score
 *      points the factor adds compared with a typical classmate. The top-4 factors are the
 *      available ones with the largest vsBaseline.
 *   6. Band from the config's thresholds: score >= critical | high | moderate, else low.
 *
 * `risk_score` is ENGINE-OWNED (access "derived" in rls/tables.ts): the app role may only
 * SELECT it. Every write here needs the owner role (ssos_owner, BYPASSRLS), so every
 * query filters by tenant_id explicitly. Reads (`getLatestRiskScore`) also work inside
 * `withTenant` on the app role.
 *
 * `risk_model_config` is engine-owned too (slice 3a): the app role may only read it, so a
 * weights change cannot skip the tenant recompute that writeRiskModelConfig performs.
 *
 * Writes:
 *   - recomputeStudentRisk: ONE new risk_score row for one student (history is kept;
 *     latest = max(computed_at)). Reads the cohort only to compute the baseline.
 *   - recomputeTenantRisk:  one new row per scorable student of the tenant.
 *   - writeRiskModelConfig: a new active config version + exactly one event row
 *     ("risk_model_config.activated"), then a full tenant recompute — all in one transaction.
 * Scores are derived data (like term_grade) and write no event rows. Every new score is then
 * handed to proposeTrackTransition (src/action-cards.ts), which may PROPOSE a track change
 * as an action card (with its own event) — a recompute never changes a track itself.
 */
import { Prisma, type PrismaClient, type RiskBand } from "@prisma/client";

import { proposeTrackTransition, type TrackProposalResult } from "./action-cards";
import { RISK_FACTORS, type RiskFactor } from "./success-defaults";

type Db = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type RiskModelErrorCode =
  | "unknown_student"
  | "not_enrolled"
  | "no_active_config"
  | "invalid_weights"
  | "invalid_thresholds"
  | "unknown_actor";

/** Thrown for input the risk model cannot use. Nothing is written. */
export class RiskModelError extends Error {
  readonly code: RiskModelErrorCode;
  constructor(code: RiskModelErrorCode, message: string) {
    super(message);
    this.name = "RiskModelError";
    this.code = code;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Signal → risk maps (0–100). Product conventions, the same for every tenant. */
export const RISK_SIGNAL_RULES = {
  /** Window (days) for the attendance trend halves and the concern-note count. */
  windowDays: 30,
  /** Grade trend needs at least this many entries (split into an earlier and a recent half). */
  gradeTrendMinEntries: 4,
  /** A drop of this many percentage points (or more) in mean grade = risk 100; no drop = 0. */
  gradeTrendDropForMax: 20,
  /** This many points below a 100% present rate (or more) = risk 100. */
  attendanceGapForMax: 25,
  /** A drop of this many points in present rate (or more) = risk 100; no drop = 0. */
  attendanceTrendDropForMax: 20,
  /** This many internal notes in the window (or more) = risk 100. */
  concernNotesForMax: 5,
} as const;

export const TOP_FACTOR_COUNT = 4;

export type RiskWeights = Record<RiskFactor, number>;
export interface BandThresholds {
  moderate: number;
  high: number;
  critical: number;
}

// ─── Pure: validation ────────────────────────────────────────────────────────

/** Validate a weights object: only known factors, finite >= 0, at least one > 0. Missing factors = 0. */
export function parseRiskWeights(raw: unknown): RiskWeights {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RiskModelError("invalid_weights", "weights must be an object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(RISK_FACTORS as readonly string[]).includes(key)) throw new RiskModelError("invalid_weights", `unknown risk factor "${key}"`);
  }
  const out = {} as RiskWeights;
  for (const f of RISK_FACTORS) {
    const v = obj[f] ?? 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new RiskModelError("invalid_weights", `weight for "${f}" must be a finite number >= 0`);
    out[f] = v;
  }
  if (!RISK_FACTORS.some((f) => out[f] > 0)) throw new RiskModelError("invalid_weights", "at least one weight must be > 0");
  return out;
}

/** Validate band thresholds: 0 <= moderate < high < critical <= 100. */
export function parseBandThresholds(raw: unknown): BandThresholds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RiskModelError("invalid_thresholds", "bandThresholds must be an object");
  const o = raw as Record<string, unknown>;
  const { moderate, high, critical } = o;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!ok(moderate) || !ok(high) || !ok(critical)) throw new RiskModelError("invalid_thresholds", "moderate, high and critical must be numbers");
  if (!(moderate >= 0 && moderate < high && high < critical && critical <= 100))
    throw new RiskModelError("invalid_thresholds", "thresholds must satisfy 0 <= moderate < high < critical <= 100");
  return { moderate, high, critical };
}

export function bandFor(score: number | Decimal, t: BandThresholds): RiskBand {
  const s = new Decimal(score.toString());
  if (s.gte(t.critical)) return "critical";
  if (s.gte(t.high)) return "high";
  if (s.gte(t.moderate)) return "moderate";
  return "low";
}

// ─── Pure: signals → risks ───────────────────────────────────────────────────

/** Raw signals per factor; null = no data. */
export type RiskSignals = Record<RiskFactor, number | null>;

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const round2 = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const clamp100 = (d: Decimal): Decimal => Decimal.max(ZERO, Decimal.min(HUNDRED, d));

/** Map one raw signal to a risk 0–100 (2 dp). */
export function signalToRisk(factor: RiskFactor, signal: number): Decimal {
  const s = new Decimal(signal.toString());
  const R = RISK_SIGNAL_RULES;
  let risk: Decimal;
  switch (factor) {
    case "gradeLevel":
      risk = HUNDRED.minus(s);
      break;
    case "gradeTrend":
      risk = s.neg().div(R.gradeTrendDropForMax).mul(100);
      break;
    case "attendanceLevel":
      risk = HUNDRED.minus(s).div(R.attendanceGapForMax).mul(100);
      break;
    case "attendanceTrend":
      risk = s.neg().div(R.attendanceTrendDropForMax).mul(100);
      break;
    case "lateMissing":
      risk = s.mul(100);
      break;
    case "engagement":
      // Engagement signal (0–100, higher = more engaged), once a source exists.
      risk = HUNDRED.minus(s);
      break;
    case "concernNotes":
      risk = s.div(R.concernNotesForMax).mul(100);
      break;
  }
  return round2(clamp100(risk));
}

export type RiskValues = Record<RiskFactor, Decimal | null>;

export function signalsToRisks(signals: RiskSignals): RiskValues {
  const out = {} as RiskValues;
  for (const f of RISK_FACTORS) {
    const s = signals[f];
    out[f] = s === null ? null : signalToRisk(f, s);
  }
  return out;
}

// ─── Pure: scoring ───────────────────────────────────────────────────────────

export interface RiskFactorResult {
  factor: RiskFactor;
  /** False when the factor had no data (not scored; contribution 0, effectiveWeight 0). */
  available: boolean;
  /** Raw signal (2 dp) or null. */
  value: number | null;
  /** Risk 0–100 (2 dp) or null. */
  risk: number | null;
  /** Configured weight. */
  weight: number;
  /** Weight after renormalising over the available factors (6 dp, display). */
  effectiveWeight: number;
  /** Score points from this factor (2 dp). Σ contributions = score exactly. */
  contribution: number;
  /** Mean risk of the grade cohort for this factor (2 dp), null when no classmate has data. */
  baseline: number | null;
  /** effectiveWeight × (risk − baseline): points above (+) or below (−) a typical classmate (2 dp). */
  vsBaseline: number | null;
  /** 1 = largest vsBaseline; null when unavailable. */
  rank: number | null;
  /** Among the top-4 surfaced factors. */
  top: boolean;
}

export interface RiskComputation {
  score: number;
  band: RiskBand;
  /** Available factors by rank, then the unavailable ones (in RISK_FACTORS order). */
  factors: RiskFactorResult[];
  /** Factors (keys) of the top 4, in rank order. */
  topFactors: RiskFactor[];
}

/**
 * Round exact parts to 2 dp so that they sum exactly to `total` (already 2 dp): floor each
 * to cents, then hand the missing cents to the largest remainders (ties: earlier index).
 */
export function apportion(parts: Decimal[], total: Decimal): Decimal[] {
  const cents = parts.map((p) => p.mul(100));
  const floors = cents.map((c) => c.floor());
  let missing = total.mul(100).minus(floors.reduce((a, b) => a.plus(b), ZERO)).toNumber();
  const order = cents.map((c, i) => ({ i, rem: c.minus(floors[i]!) })).sort((a, b) => b.rem.cmp(a.rem) || a.i - b.i);
  for (let k = 0; missing > 0 && order.length > 0; k = (k + 1) % order.length) {
    floors[order[k]!.i] = floors[order[k]!.i]!.plus(1);
    missing -= 1;
  }
  for (let k = 0; missing < 0 && order.length > 0; k = (k + 1) % order.length) {
    const idx = order[order.length - 1 - k]!.i;
    floors[idx] = floors[idx]!.minus(1);
    missing += 1;
  }
  return floors.map((c) => c.div(100));
}

/**
 * Score one student from per-factor risks. Returns null when no factor has data or every
 * available factor has weight 0 (nothing to renormalise over).
 */
export function computeRiskScore(input: {
  risks: RiskValues;
  signals?: RiskSignals;
  weights: RiskWeights;
  thresholds: BandThresholds;
  /** Cohort mean risk per factor (null = no data in the cohort). */
  baseline?: Partial<Record<RiskFactor, Decimal | number | null>>;
}): RiskComputation | null {
  const { risks, weights, thresholds } = input;
  const available = RISK_FACTORS.filter((f) => risks[f] !== null && weights[f] > 0);
  const totalWeight = available.reduce((s, f) => s.plus(weights[f].toString()), ZERO);
  if (available.length === 0 || !totalWeight.gt(0)) return null;

  const eff = new Map<RiskFactor, Decimal>(available.map((f) => [f, new Decimal(weights[f].toString()).div(totalWeight)]));
  const exact = available.map((f) => eff.get(f)!.mul(risks[f]!));
  const score = round2(clamp100(exact.reduce((a, b) => a.plus(b), ZERO)));
  const contributions = apportion(exact, score);

  const results: RiskFactorResult[] = RISK_FACTORS.map((f): RiskFactorResult => {
    const idx = available.indexOf(f);
    const risk = risks[f];
    const b = input.baseline?.[f];
    const baseline = b === null || b === undefined ? null : round2(new Decimal(b.toString()));
    const signal = input.signals?.[f] ?? null;
    const isAvail = idx >= 0;
    return {
      factor: f,
      available: isAvail,
      value: signal === null ? null : round2(new Decimal(signal.toString())).toNumber(),
      risk: risk === null ? null : risk.toNumber(),
      weight: weights[f],
      effectiveWeight: isAvail ? eff.get(f)!.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber() : 0,
      contribution: isAvail ? contributions[idx]!.toNumber() : 0,
      baseline: baseline === null ? null : baseline.toNumber(),
      vsBaseline: isAvail && baseline !== null ? round2(eff.get(f)!.mul(risk!.minus(baseline))).toNumber() : null,
      rank: null,
      top: false,
    };
  });

  // Rank available factors: largest vsBaseline first (no baseline -> its contribution
  // stands in), then larger contribution, then RISK_FACTORS order.
  const ranked = results
    .filter((r) => r.available)
    .sort((a, b) => (b.vsBaseline ?? b.contribution) - (a.vsBaseline ?? a.contribution) || b.contribution - a.contribution);
  ranked.forEach((r, i) => {
    r.rank = i + 1;
    r.top = i < TOP_FACTOR_COUNT;
  });
  const factors = [...ranked, ...results.filter((r) => !r.available)];
  return {
    score: score.toNumber(),
    band: bandFor(score, thresholds),
    factors,
    topFactors: ranked.slice(0, TOP_FACTOR_COUNT).map((r) => r.factor),
  };
}

// ─── Database helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function isPrismaClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}

function inTx<T>(db: PrismaClient | Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return isPrismaClient(db) ? db.$transaction(fn, { timeout: 120_000, maxWait: 30_000 }) : fn(db);
}

/**
 * Writers of one tenant's risk data. Config writes and tenant recomputes take the tenant
 * key exclusively; student recomputes take it shared plus their own student key.
 */
async function lockTenant(db: Db, tenantId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:risk:${tenantId}`}))`;
}
async function lockStudent(db: Db, tenantId: string, studentPersonId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`ssos:risk:${tenantId}`}))`;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:risk:${tenantId}:${studentPersonId}`}))`;
}

export interface ActiveRiskConfig {
  id: string;
  version: number;
  weights: RiskWeights;
  bandThresholds: BandThresholds;
}

/** The tenant's active config, validated. Throws `no_active_config`. */
export async function getActiveRiskModelConfig(db: PrismaClient | Db, tenantId: string): Promise<ActiveRiskConfig> {
  const row = await db.riskModelConfig.findFirst({ where: { tenantId, isActive: true }, select: { id: true, version: true, weights: true, bandThresholds: true } });
  if (!row) throw new RiskModelError("no_active_config", `tenant ${tenantId} has no active risk model config`);
  return { id: row.id, version: row.version, weights: parseRiskWeights(row.weights), bandThresholds: parseBandThresholds(row.bandThresholds) };
}

/** The current academic year: flagged is_current, else the one containing `asOf`. */
async function currentYear(db: Db, tenantId: string, asOf: Date) {
  const flagged = await db.academicYear.findFirst({ where: { tenantId, isCurrent: true }, select: { id: true, startsOn: true } });
  if (flagged) return flagged;
  return db.academicYear.findFirst({ where: { tenantId, startsOn: { lte: asOf }, endsOn: { gte: asOf } }, select: { id: true, startsOn: true } });
}

interface RosterEntry {
  studentPersonId: string;
  /** Grade cohort key: the most common course.grade of the student's enrollments (null = none). */
  grade: string | null;
  enrollmentIds: string[];
  sectionIds: string[];
}

/** Every student with an active enrollment in the year, with their grade cohort. */
async function loadRoster(db: Db, tenantId: string, academicYearId: string): Promise<Map<string, RosterEntry>> {
  const rows = await db.enrollment.findMany({
    where: { tenantId, status: "active", classSection: { course: { academicYearId } } },
    select: { id: true, studentPersonId: true, classSectionId: true, classSection: { select: { course: { select: { grade: true } } } } },
    orderBy: { id: "asc" },
  });
  const grades = new Map<string, Map<string, number>>();
  const roster = new Map<string, RosterEntry>();
  for (const r of rows) {
    const e = roster.get(r.studentPersonId) ?? { studentPersonId: r.studentPersonId, grade: null, enrollmentIds: [], sectionIds: [] };
    e.enrollmentIds.push(r.id);
    e.sectionIds.push(r.classSectionId);
    roster.set(r.studentPersonId, e);
    const g = r.classSection.course.grade;
    if (g) {
      const counts = grades.get(r.studentPersonId) ?? new Map<string, number>();
      counts.set(g, (counts.get(g) ?? 0) + 1);
      grades.set(r.studentPersonId, counts);
    }
  }
  for (const [student, counts] of grades) {
    // Most common grade; ties -> lowest label, so the cohort is deterministic.
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    roster.get(student)!.grade = best[0];
  }
  return roster;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const mean = (xs: Decimal[]): Decimal | null => (xs.length === 0 ? null : xs.reduce((a, b) => a.plus(b), ZERO).div(xs.length));

/** Raw signals for a set of students (bulk queries, one per source). */
async function loadSignals(
  db: Db,
  tenantId: string,
  year: { id: string; startsOn: Date },
  students: RosterEntry[],
  asOf: Date,
): Promise<Map<string, RiskSignals>> {
  const studentIds = students.map((s) => s.studentPersonId);
  const enrollmentToStudent = new Map<string, string>();
  for (const s of students) for (const e of s.enrollmentIds) enrollmentToStudent.set(e, s.studentPersonId);
  const sectionIds = [...new Set(students.flatMap((s) => s.sectionIds))];
  const windowStart = new Date(asOf.getTime() - RISK_SIGNAL_RULES.windowDays * DAY_MS);
  const priorStart = new Date(asOf.getTime() - 2 * RISK_SIGNAL_RULES.windowDays * DAY_MS);

  const [entries, marks, assignments, notes, anyNote] = await Promise.all([
    db.gradeEntry.findMany({
      where: { tenantId, enrollmentId: { in: [...enrollmentToStudent.keys()] }, term: { academicYearId: year.id }, gradedAt: { lte: asOf } },
      select: { enrollmentId: true, rawMark: true, gradedAt: true, id: true, gradeScale: { select: { maxValue: true } } },
      orderBy: [{ gradedAt: "asc" }, { id: "asc" }],
    }),
    db.attendanceEvent.findMany({
      where: { tenantId, studentPersonId: { in: studentIds }, enrollmentId: { in: [...enrollmentToStudent.keys()] }, date: { gte: year.startsOn, lte: asOf } },
      select: { studentPersonId: true, date: true, status: true },
    }),
    db.assignment.findMany({
      where: { tenantId, classSectionId: { in: sectionIds }, publishedAt: { not: null, lte: asOf }, dueAt: { lte: asOf } },
      select: { id: true, classSectionId: true },
    }),
    db.note.groupBy({
      by: ["subjectPersonId"],
      where: { tenantId, subjectPersonId: { in: studentIds }, visibility: "internal", createdAt: { gt: windowStart, lte: asOf } },
      _count: { _all: true },
    }),
    db.note.findFirst({ where: { tenantId }, select: { id: true } }),
  ]);
  const notesInUse = anyNote !== null;
  const submissions = assignments.length
    ? await db.submission.findMany({
        where: { tenantId, assignmentId: { in: assignments.map((a) => a.id) }, studentPersonId: { in: studentIds }, status: { not: "draft" }, submittedAt: { not: null, lte: asOf } },
        select: { assignmentId: true, studentPersonId: true, attempt: true, isLate: true },
        orderBy: { attempt: "asc" },
      })
    : [];

  // Grades: per student, entries in chronological order and per-enrollment percentages.
  const gradeByStudent = new Map<string, { ordered: Decimal[]; byEnrollment: Map<string, Decimal[]> }>();
  for (const e of entries) {
    const student = enrollmentToStudent.get(e.enrollmentId)!;
    const pct = e.rawMark.div(e.gradeScale.maxValue).mul(100);
    const g = gradeByStudent.get(student) ?? { ordered: [] as Decimal[], byEnrollment: new Map<string, Decimal[]>() };
    g.ordered.push(pct);
    g.byEnrollment.set(e.enrollmentId, [...(g.byEnrollment.get(e.enrollmentId) ?? []), pct]);
    gradeByStudent.set(student, g);
  }
  // Attendance tallies: whole year, last window, prior window.
  type Tally = { attended: number; total: number };
  const att = new Map<string, { all: Tally; recent: Tally; prior: Tally }>();
  for (const m of marks) {
    const t = att.get(m.studentPersonId) ?? { all: { attended: 0, total: 0 }, recent: { attended: 0, total: 0 }, prior: { attended: 0, total: 0 } };
    const attended = m.status === "present" || m.status === "late" ? 1 : 0;
    t.all.attended += attended;
    t.all.total += 1;
    const d = m.date.getTime();
    if (d > windowStart.getTime()) {
      t.recent.attended += attended;
      t.recent.total += 1;
    } else if (d > priorStart.getTime()) {
      t.prior.attended += attended;
      t.prior.total += 1;
    }
    att.set(m.studentPersonId, t);
  }
  const rate = (t: Tally) => new Decimal(t.attended).div(t.total).mul(100);
  // Submissions: first handed-in attempt per (assignment, student).
  const firstAttempt = new Map<string, boolean>();
  for (const s of submissions) {
    const key = `${s.assignmentId}:${s.studentPersonId}`;
    if (!firstAttempt.has(key)) firstAttempt.set(key, s.isLate);
  }
  const assignmentsBySection = new Map<string, string[]>();
  for (const a of assignments) assignmentsBySection.set(a.classSectionId, [...(assignmentsBySection.get(a.classSectionId) ?? []), a.id]);
  const noteCount = new Map(notes.map((n) => [n.subjectPersonId, n._count._all]));

  const out = new Map<string, RiskSignals>();
  for (const s of students) {
    const id = s.studentPersonId;
    const g = gradeByStudent.get(id);
    let gradeLevel: number | null = null;
    let gradeTrend: number | null = null;
    if (g) {
      gradeLevel = mean([...g.byEnrollment.values()].map((pcts) => mean(pcts)!))!.toNumber();
      const n = g.ordered.length;
      if (n >= RISK_SIGNAL_RULES.gradeTrendMinEntries) {
        const half = Math.floor(n / 2);
        gradeTrend = mean(g.ordered.slice(n - half))!.minus(mean(g.ordered.slice(0, half))!).toNumber();
      }
    }
    const a = att.get(id);
    const attendanceLevel = a ? rate(a.all).toNumber() : null;
    const attendanceTrend = a && a.recent.total > 0 && a.prior.total > 0 ? rate(a.recent).minus(rate(a.prior)).toNumber() : null;

    const due = [...new Set(s.sectionIds)].flatMap((sec) => assignmentsBySection.get(sec) ?? []);
    let lateMissing: number | null = null;
    if (due.length > 0) {
      const bad = due.filter((aid) => {
        const late = firstAttempt.get(`${aid}:${id}`);
        return late === undefined || late;
      }).length;
      lateMissing = new Decimal(bad).div(due.length).toNumber();
    }
    // Notes: a count of 0 only means "no concerns" once the tenant writes notes at all;
    // before that the factor has no data (it is renormalised away, never scored as 0).
    // A student with no other signal and no note stays unscored rather than scoring 0.
    const notesN = noteCount.get(id) ?? 0;
    const hasOther = gradeLevel !== null || attendanceLevel !== null || lateMissing !== null;
    const concernNotes = notesInUse && (hasOther || notesN > 0) ? notesN : null;

    out.set(id, { gradeLevel, gradeTrend, attendanceLevel, attendanceTrend, lateMissing, engagement: null, concernNotes });
  }
  return out;
}

/** Cohort mean risk per factor (over students with data for it) and mean cohort score. */
function cohortBaseline(risks: RiskValues[]): Record<RiskFactor, Decimal | null> {
  const out = {} as Record<RiskFactor, Decimal | null>;
  for (const f of RISK_FACTORS) out[f] = mean(risks.map((r) => r[f]).filter((v): v is Decimal => v !== null));
  return out;
}

export interface RiskScoreView {
  id: string;
  studentPersonId: string;
  modelConfigId: string;
  modelVersion: number;
  score: number;
  band: RiskBand;
  factors: RiskFactorResult[];
  cohortBaseline: CohortBaselineJson;
  computedAt: Date;
}

export interface CohortBaselineJson {
  grade: string | null;
  /** Students in the cohort (same grade, active enrollment this year). */
  cohortSize: number;
  /** Cohort students with enough data to be scored. */
  scoredCohortSize: number;
  /** Mean risk per factor across the cohort (2 dp), null = no data. */
  factors: Record<RiskFactor, number | null>;
  /** Mean score of the scored cohort (2 dp). */
  score: number | null;
  asOf: string;
}

interface ScoredStudent {
  studentPersonId: string;
  computation: RiskComputation;
  baseline: CohortBaselineJson;
}

/** Score every student of each cohort; returns the scorable ones. */
function scoreCohorts(
  roster: Map<string, RosterEntry>,
  signals: Map<string, RiskSignals>,
  config: ActiveRiskConfig,
  asOf: Date,
  only?: string,
): { scored: ScoredStudent[]; unscored: string[] } {
  const byGrade = new Map<string | null, RosterEntry[]>();
  for (const e of roster.values()) if (signals.has(e.studentPersonId)) byGrade.set(e.grade, [...(byGrade.get(e.grade) ?? []), e]);
  const scored: ScoredStudent[] = [];
  const unscored: string[] = [];
  for (const [grade, members] of byGrade) {
    const risks = new Map(members.map((m) => [m.studentPersonId, signalsToRisks(signals.get(m.studentPersonId)!)]));
    const base = cohortBaseline([...risks.values()]);
    const comps = new Map<string, RiskComputation | null>();
    for (const m of members) {
      comps.set(m.studentPersonId, computeRiskScore({ risks: risks.get(m.studentPersonId)!, signals: signals.get(m.studentPersonId)!, weights: config.weights, thresholds: config.bandThresholds, baseline: base }));
    }
    const cohortScores = [...comps.values()].filter((c): c is RiskComputation => c !== null).map((c) => new Decimal(c.score));
    const meanScore = mean(cohortScores);
    const baseline: CohortBaselineJson = {
      grade,
      cohortSize: members.length,
      scoredCohortSize: cohortScores.length,
      factors: Object.fromEntries(RISK_FACTORS.map((f) => [f, base[f] === null ? null : round2(base[f]).toNumber()])) as Record<RiskFactor, number | null>,
      score: meanScore === null ? null : round2(meanScore).toNumber(),
      asOf: asOf.toISOString(),
    };
    for (const m of members) {
      if (only && m.studentPersonId !== only) continue;
      const c = comps.get(m.studentPersonId);
      if (c) scored.push({ studentPersonId: m.studentPersonId, computation: c, baseline });
      else unscored.push(m.studentPersonId);
    }
  }
  return { scored, unscored };
}

function toView(row: {
  id: string;
  studentPersonId: string;
  modelConfigId: string;
  modelVersion: number;
  score: Decimal;
  band: RiskBand;
  factors: Prisma.JsonValue;
  cohortBaseline: Prisma.JsonValue;
  computedAt: Date;
}): RiskScoreView {
  return {
    id: row.id,
    studentPersonId: row.studentPersonId,
    modelConfigId: row.modelConfigId,
    modelVersion: row.modelVersion,
    score: row.score.toNumber(),
    band: row.band,
    factors: row.factors as unknown as RiskFactorResult[],
    cohortBaseline: row.cohortBaseline as unknown as CohortBaselineJson,
    computedAt: row.computedAt,
  };
}

const SCORE_SELECT = {
  id: true,
  studentPersonId: true,
  modelConfigId: true,
  modelVersion: true,
  score: true,
  band: true,
  factors: true,
  cohortBaseline: true,
  computedAt: true,
} as const;

function scoreData(tenantId: string, config: ActiveRiskConfig, s: ScoredStudent, computedAt: Date): Prisma.RiskScoreCreateManyInput {
  return {
    tenantId,
    studentPersonId: s.studentPersonId,
    modelConfigId: config.id,
    modelVersion: config.version,
    score: new Decimal(s.computation.score),
    band: s.computation.band,
    factors: s.computation.factors as unknown as Prisma.InputJsonValue,
    cohortBaseline: s.baseline as unknown as Prisma.InputJsonValue,
    computedAt,
  };
}

// ─── recomputeStudentRisk ────────────────────────────────────────────────────

export interface RecomputeStudentInput {
  tenantId: string;
  studentPersonId: string;
  /** Data cut-off (default: now). */
  asOf?: Date;
  /** Propose a track transition as an action card from the new score (default true). */
  proposeTracks?: boolean;
}

export type RecomputeStudentResult =
  | { status: "scored"; riskScore: RiskScoreView; proposal: TrackProposalResult | null }
  | { status: "insufficient_data"; studentPersonId: string };

/**
 * Recompute ONE student's risk: writes exactly one risk_score row for that student (or
 * none when no factor has data). The student's grade cohort is read only to compute the
 * baseline. OWNER role. Throws `unknown_student`, `not_enrolled`, `no_active_config`.
 */
export function recomputeStudentRisk(db: PrismaClient | Db, input: RecomputeStudentInput): Promise<RecomputeStudentResult> {
  return inTx(db, async (tx) => {
    const { tenantId, studentPersonId } = input;
    const asOf = input.asOf ?? new Date();
    const person = isUuid(studentPersonId) ? await tx.person.findFirst({ where: { tenantId, id: studentPersonId }, select: { id: true } }) : null;
    if (!person) throw new RiskModelError("unknown_student", `student ${studentPersonId} not found in tenant`);
    await lockStudent(tx, tenantId, studentPersonId);
    const config = await getActiveRiskModelConfig(tx, tenantId);
    const year = await currentYear(tx, tenantId, asOf);
    const roster = year ? await loadRoster(tx, tenantId, year.id) : new Map<string, RosterEntry>();
    const me = roster.get(studentPersonId);
    if (!year || !me) throw new RiskModelError("not_enrolled", `student ${studentPersonId} has no active enrollment in the current academic year`);

    const cohort = new Map([...roster].filter(([, e]) => e.grade === me.grade));
    const signals = await loadSignals(tx, tenantId, year, [...cohort.values()], asOf);
    const { scored } = scoreCohorts(cohort, signals, config, asOf, studentPersonId);
    const mine = scored[0];
    if (!mine) return { status: "insufficient_data", studentPersonId };
    const computedAt = new Date();
    const row = await tx.riskScore.create({ data: scoreData(tenantId, config, mine, computedAt) as Prisma.RiskScoreUncheckedCreateInput, select: SCORE_SELECT });
    const riskScore = toView(row);
    const proposal =
      input.proposeTracks === false ? null : await proposeTrackTransition(tx, { tenantId, riskScore, thresholds: config.bandThresholds, now: computedAt });
    return { status: "scored", riskScore, proposal };
  });
}

// ─── recomputeTenantRisk ─────────────────────────────────────────────────────

export interface RecomputeTenantInput {
  tenantId: string;
  asOf?: Date;
  /** Propose track transitions as action cards for every scored student (default true). */
  proposeTracks?: boolean;
}

export interface RecomputeTenantResult {
  modelConfigId: string;
  modelVersion: number;
  /** Students with an active enrollment in the current academic year. */
  students: number;
  /** Rows written (one per scored student). */
  scored: number;
  /** Students with no data for any weighted factor (no row written). */
  insufficientData: number;
  computedAt: Date;
  /** Track-transition proposals made from the new scores, by outcome. */
  proposals: Record<TrackProposalResult["status"], number>;
}

/** Recompute every enrolled student of the tenant with the active config. OWNER role. Throws `no_active_config`. */
export function recomputeTenantRisk(db: PrismaClient | Db, input: RecomputeTenantInput): Promise<RecomputeTenantResult> {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const asOf = input.asOf ?? new Date();
    await lockTenant(tx, tenantId);
    const config = await getActiveRiskModelConfig(tx, tenantId);
    const year = await currentYear(tx, tenantId, asOf);
    const roster = year ? await loadRoster(tx, tenantId, year.id) : new Map<string, RosterEntry>();
    const computedAt = new Date();
    if (!year || roster.size === 0)
      return { modelConfigId: config.id, modelVersion: config.version, students: 0, scored: 0, insufficientData: 0, computedAt, proposals: emptyProposalCounts() };
    const signals = await loadSignals(tx, tenantId, year, [...roster.values()], asOf);
    const { scored, unscored } = scoreCohorts(roster, signals, config, asOf);
    const rows = scored.length > 0 ? await tx.riskScore.createManyAndReturn({ data: scored.map((s) => scoreData(tenantId, config, s, computedAt)), select: SCORE_SELECT }) : [];
    const proposals = emptyProposalCounts();
    if (input.proposeTracks !== false) {
      for (const row of rows) {
        const p = await proposeTrackTransition(tx, { tenantId, riskScore: toView(row), thresholds: config.bandThresholds, now: computedAt });
        proposals[p.status] += 1;
      }
    }
    return { modelConfigId: config.id, modelVersion: config.version, students: roster.size, scored: scored.length, insufficientData: unscored.length, computedAt, proposals };
  });
}

function emptyProposalCounts(): Record<TrackProposalResult["status"], number> {
  return { proposed: 0, already_proposed: 0, no_change: 0 };
}

// ─── writeRiskModelConfig ────────────────────────────────────────────────────

export interface WriteRiskModelConfigInput {
  tenantId: string;
  /** Factor -> weight (>= 0; need not sum to 1 — the model renormalises). Missing = 0. */
  weights: Partial<Record<RiskFactor, number>>;
  /** Default: the current active version's thresholds. */
  bandThresholds?: BandThresholds;
  note?: string | null;
  /** The person making the change (recorded as creator and event actor). */
  actorPersonId?: string | null;
  actorUserId?: string | null;
  asOf?: Date;
}

export interface WriteRiskModelConfigResult {
  config: ActiveRiskConfig & { previousVersion: number | null };
  recompute: RecomputeTenantResult;
}

/**
 * Write a new config version and make it the active one (the previous version stays as
 * history), record ONE event ("risk_model_config.activated"), then recompute the whole
 * tenant with it — one transaction. OWNER role.
 * Throws `invalid_weights`, `invalid_thresholds`, `no_active_config` (no thresholds given
 * and nothing to inherit), `unknown_actor`.
 */
export function writeRiskModelConfig(db: PrismaClient | Db, input: WriteRiskModelConfigInput): Promise<WriteRiskModelConfigResult> {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const weights = parseRiskWeights(input.weights);
    await lockTenant(tx, tenantId);
    const current = await tx.riskModelConfig.findFirst({ where: { tenantId, isActive: true }, select: { id: true, version: true, bandThresholds: true } });
    const thresholdsRaw = input.bandThresholds ?? current?.bandThresholds;
    if (thresholdsRaw === undefined) throw new RiskModelError("no_active_config", "no bandThresholds given and no active config to inherit them from");
    const bandThresholds = parseBandThresholds(thresholdsRaw);
    const actor = input.actorPersonId ?? null;
    if (actor !== null) {
      const p = isUuid(actor) ? await tx.person.findFirst({ where: { tenantId, id: actor }, select: { id: true } }) : null;
      if (!p) throw new RiskModelError("unknown_actor", `person ${actor} not found in tenant`);
    }
    const max = await tx.riskModelConfig.aggregate({ where: { tenantId }, _max: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    if (current) await tx.riskModelConfig.update({ where: { id: current.id }, data: { isActive: false } });
    const created = await tx.riskModelConfig.create({
      data: { tenantId, version, weights: { ...weights }, bandThresholds: { ...bandThresholds }, isActive: true, activatedAt: new Date(), createdByPersonId: actor, note: input.note ?? null },
      select: { id: true, version: true },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: "risk_model_config.activated",
        actorPersonId: actor,
        actorUserId: input.actorUserId ?? null,
        entityType: "risk_model_config",
        entityId: created.id,
        payload: { version, previousVersion: current?.version ?? null, weights: { ...weights }, bandThresholds: { ...bandThresholds } },
      },
    });
    const recompute = await recomputeTenantRisk(tx, { tenantId, ...(input.asOf ? { asOf: input.asOf } : {}) });
    return { config: { id: created.id, version, weights, bandThresholds, previousVersion: current?.version ?? null }, recompute };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Latest risk score of a student (owner client, or app role inside withTenant). */
export async function getLatestRiskScore(db: PrismaClient | Db, tenantId: string, studentPersonId: string): Promise<RiskScoreView | null> {
  if (!isUuid(studentPersonId)) return null;
  const row = await db.riskScore.findFirst({
    where: { tenantId, studentPersonId },
    orderBy: [{ computedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: SCORE_SELECT,
  });
  return row ? toView(row) : null;
}
