/**
 * A country pack holds every country-specific value the product needs.
 * Feature code must never branch on country; it reads these fields instead.
 */
export type CountryCode = "AL" | "AE";

export type Locale = "sq" | "en" | "ar";

export interface GradeBand {
  /** Inclusive lower bound on the scale. */
  min: number;
  /** Inclusive upper bound on the scale. */
  max: number;
  /** Short label shown to users, e.g. "A" or "10". */
  label: string;
  /** Whether this band counts as a pass. */
  passing: boolean;
}

export interface GradingScale {
  /** Stable key, unique within the pack, e.g. "al-4-10". */
  key: string;
  name: string;
  kind: "numeric" | "percentage" | "letter";
  min: number;
  max: number;
  passMark: number;
  bands: GradeBand[];
}

export interface CountryPack {
  code: CountryCode;
  name: string;
  /** Bump when the pack data changes. */
  version: string;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  defaultTimezone: string;
  /** Grade levels offered by the default school type, in order. */
  grades: number[];
  /** Age at which a student can give their own data-processing consent. */
  consentAge: number;
  gradingScales: GradingScale[];
  /** Placeholder until the exam calendar slice. */
  examCalendar: { name: string; month: number }[];
}
