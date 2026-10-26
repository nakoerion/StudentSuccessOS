/**
 * The shape of a country pack, as a Zod schema. Types are inferred from it
 * (`types.ts`), and `validateCountryPack` runs on every pack at import time,
 * so malformed pack data fails loudly in typecheck, test, build and seed.
 *
 * Every fact carries `sourceIds` pointing into the pack's `sources` array,
 * and every source must be cited at least once.
 */
import { z } from "zod";

export const LOCALES = ["sq", "en", "ar"] as const;
export const COUNTRY_CODES = ["AL", "AE"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase-hyphenated key");
const sourceIds = z.array(key).min(1, "every fact needs at least one source");
const month = z.number().int().min(1).max(12);
const age = z.number().int().min(0).max(25);

export const localeSchema = z.enum(LOCALES);
export const countryCodeSchema = z.enum(COUNTRY_CODES);

export const sourceSchema = z.object({
  id: key,
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  /** "official" = ministry, legislation portal, government portal or national exam body. */
  kind: z.enum(["official", "legislation", "news", "reference"]),
  accessed: isoDate,
});

export const ageRangeSchema = z
  .object({ min: age, max: age })
  .refine((r) => r.min <= r.max, "ageRange.min must be <= ageRange.max");

export const educationStageSchema = z.object({
  key,
  /** Name in the country's language. */
  name: z.string().min(1),
  nameEn: z.string().min(1),
  /** ISCED 2011 level (0 = pre-primary, 1 = primary, 2 = lower secondary, 3 = upper secondary). */
  isced: z.number().int().min(0).max(3),
  /** Grade codes in order, e.g. ["KG1","KG2"] or ["1","2","3","4"]. Unique across the pack. */
  grades: z.array(z.string().regex(/^(KG[1-3]|[1-9]|1[0-2])$/)).min(1),
  /** Typical age at the start of the school year, first to last grade of the stage. */
  ageRange: ageRangeSchema,
  compulsory: z.boolean(),
  sourceIds,
});

export const gradeBandSchema = z.object({
  /** Inclusive lower bound on the scale. */
  min: z.number(),
  /** Inclusive upper bound on the scale. */
  max: z.number(),
  /** Short label shown to users, e.g. "A" or "10". */
  label: z.string().min(1),
  /** Optional descriptor, e.g. "Niveli II". */
  description: z.string().optional(),
  /** Whether this band counts as a pass. Must agree with the scale's passMark. */
  passing: z.boolean(),
});

/** A default weighted assessment category for courses graded on a scale (weights sum to 100). */
export const assessmentCategorySchema = z.object({
  key,
  /** Name in the country's language. */
  name: z.string().min(1),
  nameEn: z.string().min(1),
  /** Percentage weight within the course, 0 < weight <= 100. */
  weight: z.number().positive().max(100),
});

export const gradingScaleSchema = z.object({
  /** Stable key, unique within the pack, e.g. "al-4-10". */
  key,
  name: z.string().min(1),
  kind: z.enum(["numeric", "percentage", "letter"]),
  min: z.number(),
  max: z.number(),
  passMark: z.number(),
  /** Grade codes (from `grades`) this scale is used for. */
  appliesToGrades: z.array(z.string()).min(1),
  bands: z.array(gradeBandSchema).min(1),
  /**
   * Default weighted assessment categories the setup wizard creates for every
   * course on this scale. Optional: when absent the wizard uses its generic
   * placeholder set. When present, `categoriesSourceIds` must cite them.
   */
  defaultCategories: z.array(assessmentCategorySchema).optional(),
  categoriesSourceIds: z.array(key).optional(),
  notes: z.string().optional(),
  sourceIds,
});

/** A subject in the pack's national curriculum (optional pack data, seeded by the setup wizard). */
export const subjectSchema = z.object({
  /** Stable key, unique within the pack, e.g. "matematike". Stored as subject.pack_key. */
  key,
  /** Short code, unique within the pack, e.g. "MAT". Stored as subject.code. */
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/, "expected an upper-case code"),
  /** Name in the country's language. */
  name: z.string().min(1),
  nameEn: z.string().min(1),
  /** Grade codes (from `grades`) the subject is taught in; omitted = every grade. */
  grades: z.array(z.string()).optional(),
  sourceIds,
});

export const termSchema = z.object({ key, name: z.string().min(1), start: isoDate, end: isoDate });

export const examSchema = z.object({
  key,
  name: z.string().min(1),
  nameEn: z.string().min(1),
  /** Grade codes that sit the exam; omitted when it applies across grades. */
  grades: z.array(z.string()).optional(),
  /** Months (1–12) in which the exam sits. Empty only when status is "discontinued". */
  months: z.array(month),
  /** Exact window when officially published. */
  window: z.object({ start: isoDate, end: isoDate.optional() }).optional(),
  status: z.enum(["active", "discontinued"]),
  notes: z.string().optional(),
  sourceIds,
});

export const examCalendarSchema = z.object({
  /** e.g. "2026-2027". */
  academicYear: z.string().regex(/^\d{4}-\d{4}$/),
  start: isoDate,
  end: isoDate,
  /** Terms when the calendar defines them; empty when the year has no formal terms. */
  terms: z.array(termSchema),
  exams: z.array(examSchema).min(1),
  sourceIds,
});

export const consentRuleSchema = z.object({
  /** Minimum age at which the student may give this consent themselves. */
  minAge: age,
  basis: z.string().min(1),
  sourceIds,
});

export const consentAgesSchema = z.object({
  dataProcessing: consentRuleSchema,
  medical: consentRuleSchema,
  ageOfMajority: consentRuleSchema,
});

export const defaultLanguagesSchema = z.object({
  /** The pack's default UI locale; seeded into tenant.default_locale. */
  primary: localeSchema,
  secondary: z.array(localeSchema),
  notes: z.string().optional(),
  sourceIds,
});

export const countryPackSchema = z
  .object({
    code: countryCodeSchema,
    name: z.string().min(1),
    /** Bump when the pack data changes. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Date the facts were last checked against the sources. */
    researchedAt: isoDate,
    /** Locales the product offers to tenants of this country (product choice, not a cited fact). */
    supportedLocales: z.array(localeSchema).min(1),
    /** IANA time zone. */
    defaultTimezone: z.string().regex(/^[A-Za-z]+\/[A-Za-z_]+$/),
    grades: z.array(educationStageSchema).min(1),
    gradingScales: z.array(gradingScaleSchema).min(1),
    examCalendars: z.array(examCalendarSchema).min(1),
    /** National subject catalog. Optional: when absent the setup wizard uses its generic placeholder catalog. */
    subjects: z.array(subjectSchema).optional(),
    consentAges: consentAgesSchema,
    defaultLanguages: defaultLanguagesSchema,
    sources: z.array(sourceSchema).min(1),
  })
  .superRefine((pack, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    // Sources: unique ids, every reference resolves, every source is cited.
    const sourceIdSet = new Set<string>();
    pack.sources.forEach((s, i) => {
      if (sourceIdSet.has(s.id)) issue(["sources", i, "id"], `duplicate source id "${s.id}"`);
      sourceIdSet.add(s.id);
    });
    const cited = new Set<string>();
    const checkRefs = (ids: readonly string[], path: (string | number)[]) => {
      ids.forEach((id, i) => {
        cited.add(id);
        if (!sourceIdSet.has(id)) issue([...path, "sourceIds", i], `unknown source "${id}"`);
      });
    };

    // Grades: unique codes, stages in age order.
    const gradeCodes = new Set<string>();
    pack.grades.forEach((stage, i) => {
      checkRefs(stage.sourceIds, ["grades", i]);
      for (const g of stage.grades) {
        if (gradeCodes.has(g)) issue(["grades", i, "grades"], `grade "${g}" appears in more than one stage`);
        gradeCodes.add(g);
      }
      const prev = pack.grades[i - 1];
      if (prev && stage.ageRange.min <= prev.ageRange.max)
        issue(["grades", i, "ageRange"], `stage "${stage.key}" must start after "${prev.key}" ends`);
    });

    // Grading scales: unique keys, sane bounds, bands inside the scale, passing agrees with passMark.
    const scaleKeys = new Set<string>();
    pack.gradingScales.forEach((scale, i) => {
      checkRefs(scale.sourceIds, ["gradingScales", i]);
      if (scaleKeys.has(scale.key)) issue(["gradingScales", i, "key"], `duplicate scale key "${scale.key}"`);
      scaleKeys.add(scale.key);
      if (scale.min >= scale.max) issue(["gradingScales", i], "min must be < max");
      if (scale.passMark < scale.min || scale.passMark > scale.max)
        issue(["gradingScales", i, "passMark"], "passMark must lie within [min, max]");
      scale.appliesToGrades.forEach((g, j) => {
        if (!gradeCodes.has(g)) issue(["gradingScales", i, "appliesToGrades", j], `unknown grade "${g}"`);
      });
      scale.bands.forEach((band, j) => {
        const path = ["gradingScales", i, "bands", j];
        if (band.min > band.max) issue(path, "band min must be <= max");
        if (band.min < scale.min || band.max > scale.max) issue(path, "band lies outside the scale");
        if (band.passing !== band.min >= scale.passMark)
          issue(path, `band "${band.label}" passing=${band.passing} disagrees with passMark ${scale.passMark}`);
      });
      const sorted = [...scale.bands].sort((a, b) => a.min - b.min);
      if (sorted[0]?.min !== scale.min || sorted[sorted.length - 1]?.max !== scale.max)
        issue(["gradingScales", i, "bands"], "bands must cover the scale from min to max");
      if (scale.defaultCategories) {
        const path = ["gradingScales", i, "defaultCategories"];
        const total = scale.defaultCategories.reduce((s, c) => s + c.weight, 0);
        if (Math.abs(total - 100) > 1e-9) issue(path, `category weights must sum to 100 (got ${total})`);
        const catKeys = new Set(scale.defaultCategories.map((c) => c.key));
        if (catKeys.size !== scale.defaultCategories.length) issue(path, "duplicate category key");
        if (!scale.categoriesSourceIds?.length) issue(path, "defaultCategories need categoriesSourceIds");
      }
      if (scale.categoriesSourceIds) checkRefs(scale.categoriesSourceIds, ["gradingScales", i, "categories"]);
    });

    // Subjects: unique keys and codes, grades known.
    const subjectKeys = new Set<string>();
    const subjectCodes = new Set<string>();
    pack.subjects?.forEach((subject, i) => {
      const path = ["subjects", i];
      checkRefs(subject.sourceIds, path);
      if (subjectKeys.has(subject.key)) issue(path, `duplicate subject key "${subject.key}"`);
      if (subjectCodes.has(subject.code)) issue(path, `duplicate subject code "${subject.code}"`);
      subjectKeys.add(subject.key);
      subjectCodes.add(subject.code);
      subject.grades?.forEach((g) => {
        if (!gradeCodes.has(g)) issue(path, `unknown grade "${g}"`);
      });
    });

    // Exam calendars: dates ordered, terms inside the year, exam months consistent.
    pack.examCalendars.forEach((cal, i) => {
      checkRefs(cal.sourceIds, ["examCalendars", i]);
      if (cal.start >= cal.end) issue(["examCalendars", i], "start must be before end");
      cal.terms.forEach((t, j) => {
        if (t.start > t.end || t.start < cal.start || t.end > cal.end)
          issue(["examCalendars", i, "terms", j], `term "${t.key}" must lie within the academic year`);
      });
      const examKeys = new Set<string>();
      cal.exams.forEach((exam, j) => {
        const path = ["examCalendars", i, "exams", j];
        checkRefs(exam.sourceIds, path);
        if (examKeys.has(exam.key)) issue(path, `duplicate exam key "${exam.key}"`);
        examKeys.add(exam.key);
        if (exam.status === "active" && exam.months.length === 0) issue(path, "an active exam needs at least one month");
        exam.grades?.forEach((g) => {
          if (!gradeCodes.has(g)) issue(path, `unknown grade "${g}"`);
        });
        if (exam.window) {
          const { start, end = start } = exam.window;
          if (start > end) issue(path, "window start must be <= end");
          for (const d of [start, end]) {
            if (!exam.months.includes(Number(d.slice(5, 7)))) issue(path, `window date ${d} is outside months`);
          }
        }
      });
    });

    // Consent ages: never above the age of majority.
    const { dataProcessing, medical, ageOfMajority } = pack.consentAges;
    checkRefs(dataProcessing.sourceIds, ["consentAges", "dataProcessing"]);
    checkRefs(medical.sourceIds, ["consentAges", "medical"]);
    checkRefs(ageOfMajority.sourceIds, ["consentAges", "ageOfMajority"]);
    if (dataProcessing.minAge > ageOfMajority.minAge) issue(["consentAges", "dataProcessing"], "above the age of majority");
    if (medical.minAge > ageOfMajority.minAge) issue(["consentAges", "medical"], "above the age of majority");

    // Languages: primary/secondary are offered, distinct.
    const langs = pack.defaultLanguages;
    checkRefs(langs.sourceIds, ["defaultLanguages"]);
    if (langs.secondary.includes(langs.primary)) issue(["defaultLanguages", "secondary"], "secondary repeats primary");
    for (const l of [langs.primary, ...langs.secondary]) {
      if (!pack.supportedLocales.includes(l)) issue(["defaultLanguages"], `"${l}" is not in supportedLocales`);
    }

    pack.sources.forEach((s, i) => {
      if (!cited.has(s.id)) issue(["sources", i], `source "${s.id}" is never cited`);
    });
  });

/** Parse a pack, throwing a readable error listing every problem. */
export function validateCountryPack(input: unknown, label = "country pack"): z.infer<typeof countryPackSchema> {
  const result = countryPackSchema.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid ${label}:\n${lines.join("\n")}`);
  }
  return result.data;
}
