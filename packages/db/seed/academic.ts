/**
 * Minimal academic-record seed (slice 1 of the academic record: schema only).
 * Just enough rows to prove the new tables and their RLS work:
 *   - global: a few demo `concept` / `concept_edge` rows per country pack
 *   - per tenant: one `academic_year`, its `term`s, a handful of `subject`s
 * Full pack-based subject seeding and the setup wizard come in a later slice.
 *
 * Everything country-specific is read from @ssos/country-packs data — no code
 * branches on the country.
 */
import type { CountryPack, ExamCalendar } from "@ssos/country-packs";
import type { Prisma } from "@prisma/client";

import { seedId } from "./deterministic";

type Tx = Prisma.TransactionClient;

/** Standard secondary-school subjects (tenant-defined: pack_code NULL). */
export const DEMO_SUBJECTS = [
  { code: "MATH", name: "Mathematics" },
  { code: "LANG", name: "Language and Literature" },
  { code: "ENG", name: "English" },
  { code: "PHYS", name: "Physics" },
  { code: "CHEM", name: "Chemistry" },
  { code: "BIO", name: "Biology" },
  { code: "HIST", name: "History" },
  { code: "PE", name: "Physical Education" },
] as const;

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

/** Number of terms the seed creates per tenant when the pack defines none. */
const FALLBACK_TERMS = 2;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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

/** Terms from the pack calendar; if it defines none, split the year evenly (placeholder). */
function termsFor(cal: ExamCalendar): { key: string; name: string; start: Date; end: Date }[] {
  if (cal.terms.length > 0) return cal.terms.map((t) => ({ key: t.key, name: t.name, start: day(t.start), end: day(t.end) }));
  const start = day(cal.start).getTime();
  const end = day(cal.end).getTime();
  const DAY = 86_400_000;
  const span = Math.floor((end - start) / DAY) + 1;
  return Array.from({ length: FALLBACK_TERMS }, (_, i) => {
    const from = start + Math.floor((span * i) / FALLBACK_TERMS) * DAY;
    const to = start + (Math.floor((span * (i + 1)) / FALLBACK_TERMS) - 1) * DAY;
    return { key: `period-${i + 1}`, name: `Period ${i + 1}`, start: new Date(from), end: new Date(to) };
  });
}

export async function seedAcademicRecord(
  tx: Tx,
  slug: string,
  tenantId: string,
  pack: CountryPack,
): Promise<{ academicYears: number; terms: number; subjects: number }> {
  // The pack's first calendar is the current year.
  const cal = pack.examCalendars[0]!;
  const academicYearId = seedId(slug, "academic_year", cal.academicYear);
  await tx.academicYear.create({
    data: {
      id: academicYearId,
      tenantId,
      name: cal.academicYear,
      startsOn: day(cal.start),
      endsOn: day(cal.end),
      isCurrent: true,
    },
  });
  const terms = termsFor(cal);
  await tx.term.createMany({
    data: terms.map((t, i) => ({
      id: seedId(slug, "term", cal.academicYear, t.key),
      tenantId,
      academicYearId,
      key: t.key,
      name: t.name,
      sequence: i + 1,
      startsOn: t.start,
      endsOn: t.end,
    })),
  });
  await tx.subject.createMany({
    data: DEMO_SUBJECTS.map((s) => ({ id: seedId(slug, "subject", s.code), tenantId, code: s.code, name: s.name })),
  });
  return { academicYears: 1, terms: terms.length, subjects: DEMO_SUBJECTS.length };
}
