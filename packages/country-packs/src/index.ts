import { AE } from "./packs/ae";
import { AL } from "./packs/al";
import type { CountryCode, CountryPack } from "./types";

export type * from "./types";
export { AE, AL };

export const countryPacks: Readonly<Record<CountryCode, CountryPack>> = { AL, AE };

export function getCountryPack(code: CountryCode): CountryPack {
  return countryPacks[code];
}

export function isCountryCode(value: string): value is CountryCode {
  return Object.hasOwn(countryPacks, value);
}
