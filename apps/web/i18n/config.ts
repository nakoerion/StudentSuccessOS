import type { Locale } from "@ssos/country-packs";

export type { Locale };

export const LOCALES: readonly Locale[] = ["sq", "en", "ar"] as const;
export const FALLBACK_LOCALE: Locale = "en";
/** Cookie that persists the user's explicit locale choice. */
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** Cookie for the light/dark choice. */
export const THEME_COOKIE = "ssos-theme";

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar"]);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

/** Pick the first supported locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { base: tag.toLowerCase().split("-")[0] ?? "", q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((x) => x.base && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);
  return ranked.map((x) => x.base).find(isLocale) ?? null;
}

/**
 * Locale precedence: explicit cookie > the active tenant's default (from its
 * settings) > the account's saved locale > Accept-Language > fallback.
 */
export function chooseLocale(input: {
  cookie?: string | null;
  tenantDefault?: string | null;
  account?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  if (isLocale(input.tenantDefault)) return input.tenantDefault;
  if (isLocale(input.account)) return input.account;
  return negotiateLocale(input.acceptLanguage) ?? FALLBACK_LOCALE;
}
