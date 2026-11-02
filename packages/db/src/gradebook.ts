/**
 * Weighted gradebook service (slice 4a of the academic record). Service layer only.
 *
 * A grade entry is one raw mark for one enrollment, in one assessment category of the
 * enrollment's course, in one term of the course's academic year, on one grade scale.
 * `recordGradeEntry` validates it and writes it together with exactly ONE `event` row
 * ("grade_entry.created") in the same transaction (the event-per-mutation invariant).
 *
 * Derived grades (owner-written; the app role holds SELECT only on both tables):
 *   - term grade:   weighted % = Σ(category average % × weight) ÷ Σ(weight) over the
 *                   categories that have marks, in exact decimals, rounded half-up to 2 dp.
 *                   Weights need not sum to 100. Stored with the converted scale value
 *                   and an `inputs` snapshot (`deriveTermGrade`).
 *   - annual grade: equal-weight mean of the academic year's STORED term percentages;
 *                   terms without a derived grade are skipped (`deriveAnnualGrade`).
 *
 * Conversions are pure functions driven by the scale's `kind` and `bands`
 * (band JSON: { min, max, label, description?, passing, pctMin?, gpa? }):
 *   - mark → %:        mark ÷ max × 100 (identity on a percentage scale);
 *   - % → mark:        the band whose [pctMin, next pctMin) contains it (on a
 *                      percentage scale the percentage itself, × max ÷ 100);
 *   - GPA:             the band's `gpa`;
 *   - Matura-equiv.:   straight line pass mark → 5 … max → 10; below the pass mark → 4.
 * Every number here is a product convention the school must confirm (see each pack's
 * `conversionNote`); no code branches on country — all of it comes from the scale row.
 *
 * Writes need the owner role (ssos_owner, BYPASSRLS): every query filters by tenant_id
 * explicitly. Reads work on an owner client or inside `withTenant` (app role, RLS).
 */
import { Prisma, type PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type GradebookErrorCode =
  | "unknown_enrollment"
  | "unknown_category"
  | "unknown_term"
  | "unknown_scale"
  | "unknown_grader"
  | "unknown_assignment"
  | "unknown_academic_year"
  | "category_course_mismatch"
  | "term_year_mismatch"
  | "mark_out_of_range"
  | "not_a_number"
  | "no_grade_entries"
  | "zero_total_weight"
  | "no_term_grades";

/** Thrown by every gradebook write for input that cannot be recorded or derived. Nothing is written. */
export class GradebookError extends Error {
  readonly code: GradebookErrorCode;
  constructor(code: GradebookErrorCode, message: string) {
    super(message);
    this.name = "GradebookError";
    this.code = code;
  }
}

// ─── Pure: scale definition ──────────────────────────────────────────────────

export interface ScaleBand {
  min: number;
  max: number;
  label: string;
  description?: string;
  passing: boolean;
  /** Lowest percentage in the band (resolved: defaults to `min` on percentage scales). */
  pctMin: number;
  /** Points on the 4.0 GPA scale; null when the scale defines none. */
  gpa: number | null;
}

export interface ScaleDef {
  kind: string;
  min: number;
  max: number;
  passMark: number;
  /** Sorted by pctMin ascending. */
  bands: ScaleBand[];
}

type Num = number | string | Decimal;

/** Anything shaped like a `grade_scale` row (Prisma Decimals or plain numbers). */
export interface ScaleRowLike {
  kind: string;
  minValue: Num;
  maxValue: Num;
  passMark: Num;
  bands: unknown;
}

const num = (v: Num): number => (typeof v === "number" ? v : Number(v.toString()));

/**
 * Normalise a `grade_scale` row (or a pack scale `{kind,min,max,passMark,bands}`) into a
 * ScaleDef. `pctMin` defaults to `min` on percentage scales; on other scales a band
 * without `pctMin` falls back to its mark ÷ max × 100 (the pack schema requires it, so
 * this only matters for hand-made tenant scales).
 */
export function toScaleDef(row: ScaleRowLike | { kind: string; min: Num; max: Num; passMark: Num; bands: unknown }): ScaleDef {
  const min = num("minValue" in row ? row.minValue : row.min);
  const max = num("maxValue" in row ? row.maxValue : row.max);
  const passMark = num(row.passMark);
  if (!Array.isArray(row.bands) || row.bands.length === 0) throw new Error("grade scale has no bands");
  const bands = (row.bands as Record<string, unknown>[]).map((b): ScaleBand => {
    const bMin = Number(b.min);
    const bMax = Number(b.max);
    // Default: the band's min as a percentage (= min itself on a 0–100 percentage scale).
    const pctMin =
      typeof b.pctMin === "number" ? b.pctMin : new Decimal(bMin).div(max).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    const band: ScaleBand = {
      min: bMin,
      max: bMax,
      label: String(b.label),
      passing: Boolean(b.passing),
      pctMin,
      gpa: typeof b.gpa === "number" ? b.gpa : null,
    };
    if (typeof b.description === "string") band.description = b.description;
    return band;
  });
  bands.sort((a, b) => a.pctMin - b.pctMin || a.min - b.min);
  return { kind: row.kind, min, max, passMark, bands };
}

// ─── Pure: exact arithmetic ──────────────────────────────────────────────────

const round2 = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const dec = (v: Num): Decimal => (v instanceof Decimal ? v : new Decimal(typeof v === "number" ? v.toString() : v));

function assertPct(pct: Num): Decimal {
  const d = dec(pct);
  if (!d.isFinite() || d.lt(0) || d.gt(100)) throw new RangeError(`percentage must be within 0..100, got ${pct.toString()}`);
  return d;
}

/**
 * Σ(average × weight) ÷ Σ(weight), exact, rounded half-up to 2 dp. Items with a zero
 * weight still count as present but contribute nothing. Throws RangeError when the total
 * weight is not positive or the list is empty, or a weight is negative.
 */
export function weightedPercentage(items: readonly { average: Num; weight: Num }[]): number {
  if (items.length === 0) throw new RangeError("weightedPercentage needs at least one item");
  let sum = new Decimal(0);
  let weights = new Decimal(0);
  for (const it of items) {
    const w = dec(it.weight);
    if (w.lt(0)) throw new RangeError(`weight must be >= 0, got ${it.weight.toString()}`);
    sum = sum.plus(dec(it.average).mul(w));
    weights = weights.plus(w);
  }
  if (!weights.gt(0)) throw new RangeError("total weight must be > 0");
  return round2(sum.div(weights)).toNumber();
}

/** Arithmetic mean, exact, rounded half-up to 2 dp; null for an empty list. */
export function equalWeightedMean(values: readonly Num[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce<Decimal>((s, v) => s.plus(dec(v)), new Decimal(0));
  return round2(sum.div(values.length)).toNumber();
}

// ─── Pure: conversions ───────────────────────────────────────────────────────

/** The band whose [pctMin, next pctMin) contains `pct` (0..100). */
export function bandForPercentage(scale: ScaleDef, pct: Num): ScaleBand {
  const p = assertPct(pct);
  let found = scale.bands[0]!;
  for (const b of scale.bands) if (p.gte(b.pctMin)) found = b;
  return found;
}

/** mark → percentage: mark ÷ max × 100, rounded half-up to 2 dp (identity on a 0–100 percentage scale). */
export function scaleValueToPercentage(scale: ScaleDef, value: Num): number {
  const v = dec(value);
  if (!v.isFinite() || v.lt(scale.min) || v.gt(scale.max))
    throw new RangeError(`value must be within ${scale.min}..${scale.max}, got ${value.toString()}`);
  return round2(v.div(scale.max).mul(100)).toNumber();
}

/**
 * percentage → scale value. Percentage scales: the percentage itself (× max ÷ 100).
 * Other scales: the `min` of the band that contains the percentage.
 */
export function percentageToScaleValue(scale: ScaleDef, pct: Num): number {
  const p = assertPct(pct);
  if (scale.kind === "percentage") return round2(p.mul(scale.max).div(100)).toNumber();
  return bandForPercentage(scale, p).min;
}

/** percentage → GPA points (the band's `gpa`); null when the scale defines no GPA. */
export function percentageToGpa(scale: ScaleDef, pct: Num): number | null {
  return bandForPercentage(scale, pct).gpa;
}

/** scale value → GPA points, via its percentage. */
export function scaleValueToGpa(scale: ScaleDef, value: Num): number | null {
  return percentageToGpa(scale, scaleValueToPercentage(scale, value));
}

/**
 * Matura-equivalent (4–10): a straight line from the pass mark (→ 5) to the maximum
 * (→ 10), rounded half-up to 2 dp; anything below the pass mark → 4. On a 4–10 scale
 * with pass mark 5 this returns the mark itself.
 */
export function scaleValueToMatura(scale: ScaleDef, value: Num): number {
  const v = dec(value);
  if (!v.isFinite() || v.lt(scale.min) || v.gt(scale.max))
    throw new RangeError(`value must be within ${scale.min}..${scale.max}, got ${value.toString()}`);
  if (v.lt(scale.passMark)) return 4;
  if (scale.max === scale.passMark) return 10;
  return round2(
    new Decimal(5).plus(v.minus(scale.passMark).mul(5).div(new Decimal(scale.max).minus(scale.passMark))),
  ).toNumber();
}

/** percentage → Matura-equivalent, via the percentage's scale value. */
export function percentageToMatura(scale: ScaleDef, pct: Num): number {
  return scaleValueToMatura(scale, percentageToScaleValue(scale, pct));
}

export interface Conversion {
  /** The input percentage, rounded half-up to 2 dp. */
  percentage: number;
  /** Value on the scale (band min, or the percentage on a percentage scale). */
  value: number;
  label: string;
  passing: boolean;
  gpa: number | null;
  matura: number;
}

/** Everything a report needs for one percentage on one scale. */
export function convertPercentage(scale: ScaleDef, pct: Num): Conversion {
  const p = round2(assertPct(pct));
  const band = bandForPercentage(scale, p);
  const value = percentageToScaleValue(scale, p);
  return { percentage: p.toNumber(), value, label: band.label, passing: band.passing, gpa: band.gpa, matura: scaleValueToMatura(scale, value) };
}

// ─── Database helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function isPrismaClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}

function inTx<T>(db: PrismaClient | Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return isPrismaClient(db) ? db.$transaction(fn, { timeout: 60_000, maxWait: 30_000 }) : fn(db);
}

/** Serialises writers per (tenant, enrollment): grade entries and derivations of one enrollment. */
async function lockEnrollment(db: Db, tenantId: string, enrollmentId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:gradebook:${tenantId}:${enrollmentId}`}))`;
}

const SCALE_SELECT = { id: true, kind: true, minValue: true, maxValue: true, passMark: true, bands: true } as const;

/** A scale the tenant may use: its own override, or a default of the tenant's country pack. */
async function resolveScale(db: Db, tenantId: string, scaleId: string) {
  if (!isUuid(scaleId)) return null;
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { countryPackId: true } });
  if (!tenant) return null;
  return db.gradeScale.findFirst({
    where: { id: scaleId, OR: [{ tenantId }, { tenantId: null, countryPackId: tenant.countryPackId }] },
    select: SCALE_SELECT,
  });
}

async function resolveEnrollment(db: Db, tenantId: string, enrollmentId: string) {
  const e = isUuid(enrollmentId)
    ? await db.enrollment.findFirst({
        where: { tenantId, id: enrollmentId },
        select: {
          id: true,
          studentPersonId: true,
          classSection: { select: { courseId: true, course: { select: { academicYearId: true, gradeScaleId: true } } } },
        },
      })
    : null;
  if (!e) throw new GradebookError("unknown_enrollment", `enrollment ${enrollmentId} not found in tenant`);
  return {
    id: e.id,
    studentPersonId: e.studentPersonId,
    courseId: e.classSection.courseId,
    academicYearId: e.classSection.course.academicYearId,
    courseScaleId: e.classSection.course.gradeScaleId,
  };
}

async function resolveTerm(db: Db, tenantId: string, termId: string, academicYearId: string) {
  const term = isUuid(termId)
    ? await db.term.findFirst({ where: { tenantId, id: termId }, select: { id: true, academicYearId: true } })
    : null;
  if (!term) throw new GradebookError("unknown_term", `term ${termId} not found in tenant`);
  if (term.academicYearId !== academicYearId)
    throw new GradebookError("term_year_mismatch", `term ${termId} is not in the course's academic year`);
  return term;
}

/** Parse a mark: a finite number or a numeric string. Throws `not_a_number`. */
function parseMark(raw: unknown): Decimal {
  let d: Decimal | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) d = new Decimal(raw.toString());
  else if (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)) d = new Decimal(raw.trim());
  if (!d) throw new GradebookError("not_a_number", `rawMark must be a number, got ${JSON.stringify(raw) ?? String(raw)}`);
  return d;
}

// ─── recordGradeEntry ────────────────────────────────────────────────────────

export interface RecordGradeEntryInput {
  tenantId: string;
  enrollmentId: string;
  assessmentCategoryId: string;
  termId: string;
  /** Scale of the mark; default = the course's scale. Must be usable by the tenant. */
  gradeScaleId?: string | null;
  /** A number (or numeric string) within the scale's min..max; stored to 2 dp (half-up). */
  rawMark: number | string;
  assignmentId?: string | null;
  /** Person who graded (Event actor). Null = system. */
  gradedByPersonId?: string | null;
  /** Auth identity of the actor, for the Event. */
  actorUserId?: string | null;
  comment?: string | null;
  gradedAt?: Date;
}

export interface GradeEntryView {
  id: string;
  tenantId: string;
  enrollmentId: string;
  studentPersonId: string;
  assessmentCategoryId: string;
  termId: string;
  assignmentId: string | null;
  gradeScaleId: string;
  rawMark: number;
  /** rawMark ÷ scale max × 100, 2 dp. */
  percentage: number;
  gradedByPersonId: string | null;
  comment: string | null;
  gradedAt: Date;
}

/**
 * Record one mark (+ exactly one "grade_entry.created" Event, same transaction), or throw
 * `GradebookError` and write nothing. `db` must be an OWNER-role client or transaction.
 */
export function recordGradeEntry(db: PrismaClient | Db, input: RecordGradeEntryInput): Promise<GradeEntryView> {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const enrollment = await resolveEnrollment(tx, tenantId, input.enrollmentId);
    const category = isUuid(input.assessmentCategoryId)
      ? await tx.assessmentCategory.findFirst({ where: { tenantId, id: input.assessmentCategoryId }, select: { id: true, courseId: true } })
      : null;
    if (!category) throw new GradebookError("unknown_category", `assessment category ${input.assessmentCategoryId} not found in tenant`);
    if (category.courseId !== enrollment.courseId)
      throw new GradebookError("category_course_mismatch", `category ${category.id} belongs to another course than the enrollment`);
    const term = await resolveTerm(tx, tenantId, input.termId, enrollment.academicYearId);

    const scaleId = input.gradeScaleId ?? enrollment.courseScaleId;
    const scaleRow = scaleId ? await resolveScale(tx, tenantId, scaleId) : null;
    if (!scaleRow) throw new GradebookError("unknown_scale", `grade scale ${scaleId ?? "(course has none)"} is not available to the tenant`);

    const grader = input.gradedByPersonId ?? null;
    if (grader !== null) {
      const p = isUuid(grader) ? await tx.person.findFirst({ where: { tenantId, id: grader }, select: { id: true } }) : null;
      if (!p) throw new GradebookError("unknown_grader", `grader ${grader} not found in tenant`);
    }
    const assignmentId = input.assignmentId ?? null;
    if (assignmentId !== null) {
      const a = isUuid(assignmentId) ? await tx.assignment.findFirst({ where: { tenantId, id: assignmentId }, select: { id: true } }) : null;
      if (!a) throw new GradebookError("unknown_assignment", `assignment ${assignmentId} not found in tenant`);
    }

    const scale = toScaleDef(scaleRow);
    const raw = parseMark(input.rawMark);
    if (raw.lt(scale.min) || raw.gt(scale.max))
      throw new GradebookError("mark_out_of_range", `rawMark ${raw.toString()} is outside the scale's ${scale.min}..${scale.max}`);
    const mark = round2(raw);

    await lockEnrollment(tx, tenantId, enrollment.id);
    const created = await tx.gradeEntry.create({
      data: {
        tenantId,
        enrollmentId: enrollment.id,
        assessmentCategoryId: category.id,
        termId: term.id,
        assignmentId,
        gradeScaleId: scaleRow.id,
        rawMark: mark,
        gradedByPersonId: grader,
        comment: input.comment?.trim() || null,
        ...(input.gradedAt ? { gradedAt: input.gradedAt } : {}),
      },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: "grade_entry.created",
        actorPersonId: grader,
        actorUserId: input.actorUserId ?? null,
        subjectPersonId: enrollment.studentPersonId,
        entityType: "grade_entry",
        entityId: created.id,
        payload: { rawMark: mark.toNumber(), categoryId: category.id, termId: term.id, scaleId: scaleRow.id },
        evidenceRefs: assignmentId ? [{ type: "assignment", id: assignmentId }] : [],
      },
    });
    return {
      id: created.id,
      tenantId,
      enrollmentId: created.enrollmentId,
      studentPersonId: enrollment.studentPersonId,
      assessmentCategoryId: created.assessmentCategoryId,
      termId: created.termId,
      assignmentId: created.assignmentId,
      gradeScaleId: created.gradeScaleId,
      rawMark: mark.toNumber(),
      percentage: scaleValueToPercentage(scale, mark),
      gradedByPersonId: created.gradedByPersonId,
      comment: created.comment,
      gradedAt: created.gradedAt,
    };
  });
}

// ─── Derivation ──────────────────────────────────────────────────────────────

export interface DerivedGradeView {
  id: string;
  tenantId: string;
  enrollmentId: string;
  gradeScaleId: string;
  /** Value on the scale (see `percentageToScaleValue`). */
  value: number;
  /** 0..100, 2 dp. */
  percentage: number;
  label: string;
  passing: boolean;
  gpa: number | null;
  matura: number;
  inputs: unknown;
  computedAt: Date;
}
export interface TermGradeView extends DerivedGradeView {
  termId: string;
}
export interface AnnualGradeView extends DerivedGradeView {
  academicYearId: string;
}

interface DerivedRow {
  id: string;
  tenantId: string;
  enrollmentId: string;
  gradeScaleId: string;
  value: Decimal;
  percentage: Decimal | null;
  inputs: Prisma.JsonValue;
  computedAt: Date;
  gradeScale: ScaleRowLike;
}

function derivedView(r: DerivedRow): DerivedGradeView {
  const scale = toScaleDef(r.gradeScale);
  const pct = r.percentage === null ? scaleValueToPercentage(scale, r.value) : r.percentage.toNumber();
  const band = bandForPercentage(scale, pct);
  return {
    id: r.id,
    tenantId: r.tenantId,
    enrollmentId: r.enrollmentId,
    gradeScaleId: r.gradeScaleId,
    value: r.value.toNumber(),
    percentage: pct,
    label: band.label,
    passing: band.passing,
    gpa: band.gpa,
    matura: scaleValueToMatura(scale, r.value),
    inputs: r.inputs,
    computedAt: r.computedAt,
  };
}

export interface DeriveTermGradeInput {
  tenantId: string;
  enrollmentId: string;
  termId: string;
}

/**
 * Derive and upsert the term grade of one enrollment: per category, the exact mean of its
 * entries' percentages; then Σ(mean × weight) ÷ Σ(weight) over the categories with marks,
 * rounded half-up to 2 dp; converted on the course's scale. OWNER role.
 * Throws `unknown_enrollment`, `unknown_term`, `term_year_mismatch`, `unknown_scale`
 * (course without a scale), `no_grade_entries`, `zero_total_weight`.
 */
export function deriveTermGrade(db: PrismaClient | Db, input: DeriveTermGradeInput): Promise<TermGradeView> {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const enrollment = await resolveEnrollment(tx, tenantId, input.enrollmentId);
    const term = await resolveTerm(tx, tenantId, input.termId, enrollment.academicYearId);
    const scaleRow = enrollment.courseScaleId ? await resolveScale(tx, tenantId, enrollment.courseScaleId) : null;
    if (!scaleRow) throw new GradebookError("unknown_scale", `the course of enrollment ${enrollment.id} has no usable grade scale`);
    const scale = toScaleDef(scaleRow);

    await lockEnrollment(tx, tenantId, enrollment.id);
    const entries = await tx.gradeEntry.findMany({
      where: { tenantId, enrollmentId: enrollment.id, termId: term.id },
      select: {
        rawMark: true,
        assessmentCategoryId: true,
        assessmentCategory: { select: { name: true, weight: true } },
        gradeScale: { select: SCALE_SELECT },
      },
      orderBy: [{ gradedAt: "asc" }, { id: "asc" }],
    });
    if (entries.length === 0) throw new GradebookError("no_grade_entries", `no grade entries for enrollment ${enrollment.id} in term ${term.id}`);

    const scaleCache = new Map<string, ScaleDef>();
    const byCategory = new Map<string, { name: string; weight: Decimal; pcts: Decimal[] }>();
    for (const e of entries) {
      let s = scaleCache.get(e.gradeScale.id);
      if (!s) scaleCache.set(e.gradeScale.id, (s = toScaleDef(e.gradeScale)));
      // Exact entry percentage (no rounding before the weighted sum).
      const pct = e.rawMark.div(s.max).mul(100);
      const c = byCategory.get(e.assessmentCategoryId) ?? { name: e.assessmentCategory.name, weight: e.assessmentCategory.weight, pcts: [] };
      c.pcts.push(pct);
      byCategory.set(e.assessmentCategoryId, c);
    }
    const categories = [...byCategory.entries()].map(([id, c]) => ({
      categoryId: id,
      name: c.name,
      weight: c.weight,
      count: c.pcts.length,
      average: c.pcts.reduce((a, b) => a.plus(b), new Decimal(0)).div(c.pcts.length),
    }));
    const totalWeight = categories.reduce((s, c) => s.plus(c.weight), new Decimal(0));
    if (!totalWeight.gt(0)) throw new GradebookError("zero_total_weight", "the categories with marks have a total weight of 0");
    const percentage = weightedPercentage(categories);
    const value = percentageToScaleValue(scale, percentage);
    const inputs = {
      formula: "sum(categoryAverage * weight) / sum(weight)",
      totalWeight: totalWeight.toNumber(),
      categories: categories.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        weight: c.weight.toNumber(),
        entries: c.count,
        average: round2(c.average).toNumber(),
      })),
    };
    const data = { gradeScaleId: scaleRow.id, value, percentage, inputs, computedAt: new Date() };
    const row = await tx.termGrade.upsert({
      where: { tenantId_enrollmentId_termId: { tenantId, enrollmentId: enrollment.id, termId: term.id } },
      create: { tenantId, enrollmentId: enrollment.id, termId: term.id, ...data },
      update: data,
      include: { gradeScale: { select: SCALE_SELECT } },
    });
    return { ...derivedView(row), termId: row.termId };
  });
}

export interface DeriveAnnualGradeInput {
  tenantId: string;
  enrollmentId: string;
  academicYearId: string;
}

/**
 * Derive and upsert the annual grade: equal-weight mean of the year's STORED term
 * percentages (derive term grades first; terms without one are skipped), rounded
 * half-up to 2 dp, converted on the course's scale. OWNER role.
 * Throws `unknown_enrollment`, `unknown_academic_year`, `term_year_mismatch` (year is
 * not the course's), `unknown_scale`, `no_term_grades`.
 */
export function deriveAnnualGrade(db: PrismaClient | Db, input: DeriveAnnualGradeInput): Promise<AnnualGradeView> {
  return inTx(db, async (tx) => {
    const { tenantId } = input;
    const enrollment = await resolveEnrollment(tx, tenantId, input.enrollmentId);
    const year = isUuid(input.academicYearId)
      ? await tx.academicYear.findFirst({ where: { tenantId, id: input.academicYearId }, select: { id: true } })
      : null;
    if (!year) throw new GradebookError("unknown_academic_year", `academic year ${input.academicYearId} not found in tenant`);
    if (year.id !== enrollment.academicYearId)
      throw new GradebookError("term_year_mismatch", `academic year ${year.id} is not the enrollment's course year`);
    const scaleRow = enrollment.courseScaleId ? await resolveScale(tx, tenantId, enrollment.courseScaleId) : null;
    if (!scaleRow) throw new GradebookError("unknown_scale", `the course of enrollment ${enrollment.id} has no usable grade scale`);
    const scale = toScaleDef(scaleRow);

    await lockEnrollment(tx, tenantId, enrollment.id);
    const termGrades = await tx.termGrade.findMany({
      where: { tenantId, enrollmentId: enrollment.id, term: { academicYearId: year.id }, percentage: { not: null } },
      select: { termId: true, percentage: true, term: { select: { sequence: true, key: true } } },
      orderBy: { term: { sequence: "asc" } },
    });
    if (termGrades.length === 0) throw new GradebookError("no_term_grades", `no derived term grades for enrollment ${enrollment.id} in year ${year.id}`);
    const percentage = equalWeightedMean(termGrades.map((t) => t.percentage!))!;
    const value = percentageToScaleValue(scale, percentage);
    const inputs = {
      formula: "mean(termPercentage)",
      terms: termGrades.map((t) => ({ termId: t.termId, key: t.term.key, sequence: t.term.sequence, percentage: t.percentage!.toNumber() })),
    };
    const data = { gradeScaleId: scaleRow.id, value, percentage, inputs, computedAt: new Date() };
    const row = await tx.annualGrade.upsert({
      where: { tenantId_enrollmentId_academicYearId: { tenantId, enrollmentId: enrollment.id, academicYearId: year.id } },
      create: { tenantId, enrollmentId: enrollment.id, academicYearId: year.id, ...data },
      update: data,
      include: { gradeScale: { select: SCALE_SELECT } },
    });
    return { ...derivedView(row), academicYearId: row.academicYearId };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface ListGradeEntriesArgs {
  tenantId: string;
  enrollmentId?: string;
  termId?: string;
  assessmentCategoryId?: string;
  studentPersonId?: string;
}

/** Grade entries matching every given filter, oldest first. Owner client or inside `withTenant`. */
export async function listGradeEntries(db: PrismaClient | Db, args: ListGradeEntriesArgs): Promise<GradeEntryView[]> {
  const where: Prisma.GradeEntryWhereInput = { tenantId: args.tenantId };
  if (args.enrollmentId !== undefined) where.enrollmentId = args.enrollmentId;
  if (args.termId !== undefined) where.termId = args.termId;
  if (args.assessmentCategoryId !== undefined) where.assessmentCategoryId = args.assessmentCategoryId;
  if (args.studentPersonId !== undefined) where.enrollment = { studentPersonId: args.studentPersonId };
  const rows = await db.gradeEntry.findMany({
    where,
    include: { enrollment: { select: { studentPersonId: true } }, gradeScale: { select: SCALE_SELECT } },
    orderBy: [{ gradedAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    enrollmentId: r.enrollmentId,
    studentPersonId: r.enrollment.studentPersonId,
    assessmentCategoryId: r.assessmentCategoryId,
    termId: r.termId,
    assignmentId: r.assignmentId,
    gradeScaleId: r.gradeScaleId,
    rawMark: r.rawMark.toNumber(),
    percentage: scaleValueToPercentage(toScaleDef(r.gradeScale), r.rawMark),
    gradedByPersonId: r.gradedByPersonId,
    comment: r.comment,
    gradedAt: r.gradedAt,
  }));
}

/** The stored term grade, or null. Owner client or inside `withTenant`. */
export async function getTermGrade(
  db: PrismaClient | Db,
  args: { tenantId: string; enrollmentId: string; termId: string },
): Promise<TermGradeView | null> {
  const row = await db.termGrade.findFirst({
    where: { tenantId: args.tenantId, enrollmentId: args.enrollmentId, termId: args.termId },
    include: { gradeScale: { select: SCALE_SELECT } },
  });
  return row ? { ...derivedView(row), termId: row.termId } : null;
}

/** The stored annual grade, or null. Owner client or inside `withTenant`. */
export async function getAnnualGrade(
  db: PrismaClient | Db,
  args: { tenantId: string; enrollmentId: string; academicYearId: string },
): Promise<AnnualGradeView | null> {
  const row = await db.annualGrade.findFirst({
    where: { tenantId: args.tenantId, enrollmentId: args.enrollmentId, academicYearId: args.academicYearId },
    include: { gradeScale: { select: SCALE_SELECT } },
  });
  return row ? { ...derivedView(row), academicYearId: row.academicYearId } : null;
}
