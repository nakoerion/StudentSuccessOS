import type { CountryPack } from "../types";

// TODO: researched values in later slice. Everything below is a placeholder
// chosen to give the seed something plausible to read. Do not rely on it.
export const AE: CountryPack = {
  code: "AE",
  name: "United Arab Emirates",
  version: "0.0.1-placeholder",
  defaultLocale: "en",
  supportedLocales: ["en", "ar"],
  defaultTimezone: "Asia/Dubai",
  // TODO: researched values in later slice.
  grades: [6, 7, 8, 9, 10, 11, 12],
  // TODO: researched values in later slice.
  consentAge: 18,
  gradingScales: [
    {
      key: "ae-percentage",
      name: "Percentage with letter bands",
      kind: "percentage",
      min: 0,
      max: 100,
      passMark: 60,
      bands: [
        { min: 90, max: 100, label: "A", passing: true },
        { min: 80, max: 89, label: "B", passing: true },
        { min: 70, max: 79, label: "C", passing: true },
        { min: 60, max: 69, label: "D", passing: true },
        { min: 0, max: 59, label: "F", passing: false },
      ],
    },
  ],
  // TODO: researched values in later slice.
  examCalendar: [{ name: "End of Term 3 assessments", month: 6 }],
};
