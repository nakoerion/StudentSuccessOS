/**
 * A country pack holds every country-specific value the product needs.
 * Feature code must never branch on country; it reads these fields instead.
 * The types are inferred from the Zod schema in `schema.ts`.
 */
import type { z } from "zod";

import type {
  consentAgesSchema,
  consentRuleSchema,
  countryCodeSchema,
  countryPackSchema,
  defaultLanguagesSchema,
  educationStageSchema,
  examCalendarSchema,
  examSchema,
  gradeBandSchema,
  gradingScaleSchema,
  localeSchema,
  sourceSchema,
  termSchema,
} from "./schema";

export type CountryCode = z.infer<typeof countryCodeSchema>;
export type Locale = z.infer<typeof localeSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type EducationStage = z.infer<typeof educationStageSchema>;
export type GradeBand = z.infer<typeof gradeBandSchema>;
export type GradingScale = z.infer<typeof gradingScaleSchema>;
export type Term = z.infer<typeof termSchema>;
export type Exam = z.infer<typeof examSchema>;
export type ExamCalendar = z.infer<typeof examCalendarSchema>;
export type ConsentRule = z.infer<typeof consentRuleSchema>;
export type ConsentAges = z.infer<typeof consentAgesSchema>;
export type DefaultLanguages = z.infer<typeof defaultLanguagesSchema>;
/** Input shape (what a pack file declares). */
export type CountryPackInput = z.input<typeof countryPackSchema>;
/** Validated pack. */
export type CountryPack = z.infer<typeof countryPackSchema>;
