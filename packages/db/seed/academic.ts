/**
 * Minimal academic-record seed (slice 1 of the academic record: schema only).
 * Just enough rows to prove the new tables and their RLS work:
 *   - global: a few demo `concept` / `concept_edge` rows per country pack
 * Per-tenant academic years, terms, subjects, courses, sections, enrollments,
 * teacher assignments and assessment categories come from the setup wizard
 * (src/setup-wizard.ts), which seed/index.ts runs for every demo tenant.
 *
 * Everything country-specific is read from @ssos/country-packs data — no code
 * branches on the country.
 */
import type { Prisma } from "@prisma/client";

import { seedId } from "./deterministic";

type Tx = Prisma.TransactionClient;

/**
 * Demo curriculum codes. These are placeholders that exercise the concept graph,
 * NOT official curriculum codes; real codes arrive with pack curriculum data.
 * `code` is prefixed with the pack code at seed time.
 */
export const DEMO_CONCEPTS = [
  { key: "MATH.ALG.LIN", subjectKey: "MATH", name: "Linear equations" },
  { key: "MATH.ALG.QUAD", subjectKey: "MATH", name: "Quadratic equations" },
  { key: "MATH.FUN.BASICS", subjectKey: "MATH", name: "Functions and graphs" },
  { key: "PHYS.MECH.KIN", subjectKey: "PHYS", name: "Kinematics" },
] as const;

export const DEMO_CONCEPT_EDGES = [
  { source: "MATH.ALG.LIN", target: "MATH.ALG.QUAD", edgeType: "prerequisite" },
  { source: "MATH.ALG.LIN", target: "MATH.FUN.BASICS", edgeType: "prerequisite" },
  { source: "MATH.FUN.BASICS", target: "PHYS.MECH.KIN", edgeType: "related" },
] as const;

export async function seedConcepts(tx: Tx, countryPackId: string, packCode: string): Promise<void> {
  const ids: Record<string, string> = {};
  for (const c of DEMO_CONCEPTS) {
    const code = `${packCode}.${c.key}`;
    const values = {
      name: c.name,
      subjectKey: c.subjectKey,
      description: "Demo curriculum code (placeholder until pack curriculum data lands).",
    };
    const row = await tx.concept.upsert({
      where: { countryPackId_code: { countryPackId, code } },
      create: { id: seedId("concept", packCode, c.key), countryPackId, code, ...values },
      update: values,
    });
    ids[c.key] = row.id;
  }
  for (const e of DEMO_CONCEPT_EDGES) {
    const sourceConceptId = ids[e.source]!;
    const targetConceptId = ids[e.target]!;
    await tx.conceptEdge.upsert({
      where: {
        sourceConceptId_targetConceptId_edgeType: { sourceConceptId, targetConceptId, edgeType: e.edgeType },
      },
      create: {
        id: seedId("concept_edge", packCode, e.source, e.target, e.edgeType),
        sourceConceptId,
        targetConceptId,
        edgeType: e.edgeType,
      },
      update: {},
    });
  }
}
