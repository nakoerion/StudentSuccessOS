// Stub. Slice 2 adds design tokens (colour, type, spacing; light/dark) and
// RTL-safe primitives built on Tailwind + shadcn/ui.
export const UI_PACKAGE = "@ssos/ui" as const;

export type Direction = "ltr" | "rtl";

/** Text direction for a locale. Arabic is the only RTL locale we ship. */
export function directionFor(locale: string): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}
