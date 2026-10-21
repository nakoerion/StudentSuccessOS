import { AE_INPUT } from "./packs/ae";
import { AL_INPUT } from "./packs/al";
import { LOCALES, validateCountryPack } from "./schema";
import type { CountryCode, CountryPack, Locale } from "./types";

export type * from "./types";
export { COUNTRY_CODES, countryPackSchema, LOCALES, validateCountryPack } from "./schema";

// Validated at import time: a malformed pack throws here, so typecheck-adjacent
// steps (tests, build, seed) fail loudly instead of shipping bad data.
export const AL: CountryPack = validateCountryPack(AL_INPUT, "country pack AL");
export const AE: CountryPack = validateCountryPack(AE_INPUT, "country pack AE");

export const countryPacks: Readonly<Record<CountryCode, CountryPack>> = { AL, AE };

export function getCountryPack(code: CountryCode): CountryPack {
  return countryPacks[code];
}

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && Object.hasOwn(countryPacks, value);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The pack's default UI locale (`defaultLanguages.primary`). */
export function packDefaultLocale(pack: CountryPack): Locale {
  return pack.defaultLanguages.primary;
}

/**
 * The effective default locale for a tenant: the tenant's own `default_locale`
 * when it is a locale its pack supports, otherwise the pack's primary language.
 * Returns null only when neither is known (unknown country and no valid locale),
 * so callers can fall through to their own fallback chain.
 */
export function resolveTenantLocale(input: {
  tenantLocale?: string | null;
  countryCode?: string | null;
}): Locale | null {
  const pack = isCountryCode(input.countryCode) ? countryPacks[input.countryCode] : null;
  if (pack) {
    if (isLocale(input.tenantLocale) && pack.supportedLocales.includes(input.tenantLocale)) return input.tenantLocale;
    return packDefaultLocale(pack);
  }
  return isLocale(input.tenantLocale) ? input.tenantLocale : null;
}
