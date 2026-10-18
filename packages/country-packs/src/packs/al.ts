import type { CountryPack } from "../types";

// TODO: researched values in later slice. Everything below is a placeholder
// chosen to give the seed something plausible to read. Do not rely on it.
export const AL: CountryPack = {
  code: "AL",
  name: "Albania",
  version: "0.0.1-placeholder",
  defaultLocale: "sq",
  supportedLocales: ["sq", "en"],
  defaultTimezone: "Europe/Tirane",
  // Upper secondary ("gjimnaz" / liceu) grades. TODO: researched values in later slice.
  grades: [10, 11, 12],
  // TODO: researched values in later slice.
  consentAge: 16,
  gradingScales: [
    {
      key: "al-4-10",
      name: "Shkalla 4–10",
      kind: "numeric",
      min: 4,
      max: 10,
      passMark: 5,
      bands: [
        { min: 4, max: 4, label: "4", passing: false },
        { min: 5, max: 5, label: "5", passing: true },
        { min: 6, max: 6, label: "6", passing: true },
        { min: 7, max: 7, label: "7", passing: true },
        { min: 8, max: 8, label: "8", passing: true },
        { min: 9, max: 9, label: "9", passing: true },
        { min: 10, max: 10, label: "10", passing: true },
      ],
    },
  ],
  // TODO: researched values in later slice.
  examCalendar: [{ name: "Matura Shtetërore", month: 6 }],
};
