/**
 * Demo concept mastery for the seeded tenants (SYNTHETIC — demo only).
 *
 * Mastery is written by sso-ai's tutor (Bayesian Knowledge Tracing) into its own database,
 * `ai.mastery_state`, keyed by the same person ids as this database. A fresh demo has no
 * tutor history, so the advisor heatmap would be empty; this writes deterministic synthetic
 * rows there so the real screen, reading the real endpoint, has something to show.
 *
 * Opt-in twice: the existing demo flag (SSOS_SEED_SUCCESS_DEMO=1) AND a connection string to
 * sso-ai's database (SSOS_SEED_AI_DATABASE_URL). Re-runnable: each demo tenant's rows are
 * deleted and rewritten with the same values.
 *
 * Same rules for every tenant and country — concept codes come from the pack's demo concepts.
 */
import { PrismaClient } from "@prisma/client";

import { DEMO_CONCEPTS } from "./academic";
import type { SeedStudent } from "./success";

export interface DemoMasteryRow {
  studentId: string;
  conceptCode: string;
  pMastery: number;
  attempts: number;
  correct: number;
  lastSeen: Date;
}

/** Per-concept class difficulty: the demo class struggles most with quadratics, then kinematics. */
const CONCEPT_BASE: Record<(typeof DEMO_CONCEPTS)[number]["key"], number> = {
  "MATH.ALG.LIN": 0.78,
  "MATH.ALG.QUAD": 0.36,
  "MATH.FUN.BASICS": 0.6,
  "PHYS.MECH.KIN": 0.48,
};

const AS_OF = Date.UTC(2026, 10, 14, 12, 0, 0);
const clamp = (v: number) => Math.min(0.97, Math.max(0.05, v));

/**
 * Deterministic synthetic mastery. Every 9th student (index % 9 === 4) has never used the
 * tutor (no rows at all); some other cells are left untouched (no data, not zero). Students
 * who struggle in the success demo (index % 7 === 2) sit lower; strong ones (index % 5 === 0)
 * higher.
 */
export function demoMastery(packCode: string, students: readonly SeedStudent[]): DemoMasteryRow[] {
  const rows: DemoMasteryRow[] = [];
  for (const s of students) {
    if (s.index % 9 === 4) continue;
    const offset = s.index % 7 === 2 ? -0.2 : s.index % 5 === 0 ? 0.15 : 0;
    DEMO_CONCEPTS.forEach((c, ci) => {
      if ((s.index + ci * 2) % 6 === 1) return;
      const wobble = (((s.index * 31 + ci * 17) % 13) - 6) / 50; // -0.12..0.12
      const pMastery = Math.round(clamp(CONCEPT_BASE[c.key] + offset + wobble) * 1000) / 1000;
      const attempts = 2 + ((s.index * 7 + ci * 3) % 11);
      rows.push({
        studentId: s.id,
        conceptCode: `${packCode}.${c.key}`,
        pMastery,
        attempts,
        correct: Math.min(attempts, Math.round(attempts * pMastery)),
        lastSeen: new Date(AS_OF - ((s.index + ci) % 10) * 86_400_000),
      });
    });
  }
  return rows;
}

export function seedMasteryDemoUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SSOS_SEED_SUCCESS_DEMO === "1" && env.SSOS_SEED_AI_DATABASE_URL ? env.SSOS_SEED_AI_DATABASE_URL : null;
}

/** Replaces the demo tenants' rows in sso-ai's `ai.mastery_state`. */
export async function seedMasteryDemo(url: string, tenants: { tenantId: string; rows: DemoMasteryRow[] }[]): Promise<number> {
  const ai = new PrismaClient({ datasourceUrl: url });
  try {
    let n = 0;
    await ai.$transaction(async (tx) => {
      for (const { tenantId, rows } of tenants) {
        await tx.$executeRaw`DELETE FROM ai.mastery_state WHERE tenant_id = ${tenantId}::uuid`;
        for (const r of rows) {
          await tx.$executeRaw`
            INSERT INTO ai.mastery_state (tenant_id, student_id, concept_code, p_mastery, attempts, correct, last_seen)
            VALUES (${tenantId}::uuid, ${r.studentId}::uuid, ${r.conceptCode}, ${r.pMastery}, ${r.attempts}, ${r.correct}, ${r.lastSeen})`;
          n++;
        }
      }
    });
    return n;
  } finally {
    await ai.$disconnect();
  }
}
