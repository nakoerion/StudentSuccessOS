/**
 * Advisor mastery heatmap: which classes an advisor can pick, whose mastery to read, and the
 * pure maths that turns sso-ai's per-student cells into a grid and a class summary.
 *
 * "No data" and "zero mastery" are different things: a student with no attempts on a concept
 * has not been assessed, so the cell is empty and the student is left out of the class average
 * for that concept rather than counted as 0.
 *
 * DB loaders run inside withTenant, so RLS bounds them to the tenant.
 */
import type { TenantTx } from "@ssos/db";

import type { MasteryResult } from "./client";

export interface MasteryClass {
  id: string;
  name: string;
  code: string;
}

export interface MasteryStudent {
  id: string;
  name: string;
}

/** The school's classes (class-kind units that have sections), in a stable order. */
export async function loadMasteryClasses(tx: TenantTx): Promise<MasteryClass[]> {
  const rows = await tx.tenantUnit.findMany({
    where: { kind: "class" },
    select: { id: true, name: true, code: true, gradeLevel: true },
  });
  return rows
    .sort((a, b) => (a.gradeLevel ?? 0) - (b.gradeLevel ?? 0) || a.code.localeCompare(b.code))
    .map(({ id, name, code }) => ({ id, name, code }));
}

/** Students actively enrolled in any section drawn from the class, by name. */
export async function loadClassStudents(tx: TenantTx, classId: string): Promise<MasteryStudent[]> {
  const rows = await tx.enrollment.findMany({
    where: { status: "active", classSection: { tenantUnitId: classId } },
    select: { student: { select: { id: true, displayName: true } } },
  });
  const byId = new Map(rows.map((r) => [r.student.id, r.student.displayName]));
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Concept code → display name from the tenant's country pack (codes without a row show as codes). */
export async function loadConceptNames(tx: TenantTx, tenantId: string, codes: string[]): Promise<Record<string, string>> {
  if (codes.length === 0) return {};
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { countryPackId: true } });
  const rows = await tx.concept.findMany({
    where: { countryPackId: tenant.countryPackId, code: { in: codes } },
    select: { code: true, name: true },
  });
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

// ─── Pure maths ──────────────────────────────────────────────────────────────

export interface GridCell {
  pMastery: number;
  attempts: number;
  correct: number;
}

export interface MasteryGrid {
  concepts: string[];
  rows: { studentId: string; cells: Record<string, GridCell | null> }[];
}

export interface ConceptSummary {
  conceptCode: string;
  /** Mean pMastery over assessed students only. */
  average: number;
  /** Students with at least one attempt on this concept. */
  assessed: number;
}

/** A cell only counts when the student has actually attempted the concept. */
function assessed(c: { attempts: number } | undefined | null): boolean {
  return !!c && c.attempts > 0;
}

/** Students (in the given order) × concepts; a missing or zero-attempt cell is null = no data. */
export function buildGrid(result: MasteryResult, studentIds: string[]): MasteryGrid {
  const byStudent = new Map(result.students.map((s) => [s.studentId, s.mastery]));
  const rows = studentIds.map((studentId) => {
    const cells: Record<string, GridCell | null> = {};
    for (const code of result.concepts) {
      const c = byStudent.get(studentId)?.find((m) => m.conceptCode === code);
      cells[code] = assessed(c) ? { pMastery: c!.pMastery, attempts: c!.attempts, correct: c!.correct } : null;
    }
    return { studentId, cells };
  });
  return { concepts: result.concepts, rows };
}

/**
 * Per-concept class averages, weakest first. Students with no attempts on a concept are
 * ignored (not counted as zero); concepts nobody in the class has attempted are omitted.
 */
export function summarizeConcepts(grid: MasteryGrid): ConceptSummary[] {
  const out: ConceptSummary[] = [];
  for (const code of grid.concepts) {
    const values = grid.rows.map((r) => r.cells[code]).filter((c): c is GridCell => c !== null && c !== undefined);
    if (values.length === 0) continue;
    out.push({ conceptCode: code, average: values.reduce((s, c) => s + c.pMastery, 0) / values.length, assessed: values.length });
  }
  return out.sort((a, b) => a.average - b.average || a.conceptCode.localeCompare(b.conceptCode));
}

/** True when no student in the grid has a single attempt (the honest empty state). */
export function gridIsEmpty(grid: MasteryGrid): boolean {
  return grid.rows.every((r) => Object.values(r.cells).every((c) => c === null));
}

export const MASTERY_LEVELS = ["low", "developing", "secure", "strong"] as const;
export type MasteryLevel = (typeof MASTERY_LEVELS)[number];

/** Colour band for a pMastery value. */
export function masteryLevel(p: number): MasteryLevel {
  if (p < 0.4) return "low";
  if (p < 0.6) return "developing";
  if (p < 0.8) return "secure";
  return "strong";
}
