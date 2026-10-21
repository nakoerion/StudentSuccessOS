import { describe, expect, it } from "vitest";

import { AE, AL, countryPacks, countryPackSchema, type CountryPackInput, resolveTenantLocale, validateCountryPack } from "../src";
import { AE_INPUT } from "../src/packs/ae";
import { AL_INPUT } from "../src/packs/al";

const clone = (v: CountryPackInput): CountryPackInput => structuredClone(v);

describe("country packs", () => {
  it.each(Object.entries(countryPacks))("%s validates against the schema", (_code, pack) => {
    expect(countryPackSchema.safeParse(pack).success).toBe(true);
  });

  it("cover the five dimensions, each with at least one cited source", () => {
    for (const pack of [AL, AE]) {
      expect(pack.grades.length).toBeGreaterThan(0);
      expect(pack.gradingScales.length).toBeGreaterThan(0);
      expect(pack.examCalendars.length).toBeGreaterThan(0);
      expect(pack.consentAges.dataProcessing.sourceIds.length).toBeGreaterThan(0);
      expect(pack.defaultLanguages.sourceIds.length).toBeGreaterThan(0);
      for (const s of pack.sources) expect(s.url).toMatch(/^https:\/\//);
    }
  });

  it("Albania: fillor 1–5, i mesëm i ulët 6–9, i mesëm i lartë 10–12; marks 4–10, pass 5; sq", () => {
    const stage = (key: string) => AL.grades.find((s) => s.key === key)?.grades;
    expect(stage("fillor")).toEqual(["1", "2", "3", "4", "5"]);
    expect(stage("mesem-i-ulet")).toEqual(["6", "7", "8", "9"]);
    expect(stage("mesem-i-larte")).toEqual(["10", "11", "12"]);
    expect(AL.gradingScales[0]).toMatchObject({ min: 4, max: 10, passMark: 5 });
    const exams = AL.examCalendars[0]!.exams.map((e) => [e.key, e.months]);
    expect(exams).toContainEqual(["matura-shteterore", [6]]);
    expect(exams).toContainEqual(["provimet-kombetare-arsimi-baze", [6]]);
    expect(AL.consentAges.dataProcessing.minAge).toBe(16);
    expect(AL.defaultLanguages).toMatchObject({ primary: "sq", secondary: [] });
  });

  it("UAE: KG + cycles 1–4 / 5–8 / 9–12; 0–100 pass 60; EmSAT discontinued; en + ar", () => {
    expect(AE.grades.map((s) => s.grades)).toEqual([
      ["KG1", "KG2"],
      ["1", "2", "3", "4"],
      ["5", "6", "7", "8"],
      ["9", "10", "11", "12"],
    ]);
    expect(AE.gradingScales[0]).toMatchObject({ kind: "percentage", min: 0, max: 100, passMark: 60 });
    expect(AE.examCalendars[0]!.terms).toHaveLength(3);
    expect(AE.examCalendars[0]!.exams.find((e) => e.key === "emsat")?.status).toBe("discontinued");
    expect(AE.consentAges.medical.minAge).toBe(18);
    expect(AE.defaultLanguages).toMatchObject({ primary: "en", secondary: ["ar"] });
  });
});

describe("validation fails loudly on malformed packs", () => {
  it("rejects a citation to a source that does not exist", () => {
    const bad = clone(AL_INPUT);
    bad.grades[0]!.sourceIds = ["no-such-source"];
    expect(() => validateCountryPack(bad)).toThrow(/unknown source "no-such-source"/);
  });

  it("rejects an uncited source", () => {
    const bad = clone(AE_INPUT);
    bad.sources.push({ ...bad.sources[0]!, id: "orphan" });
    expect(() => validateCountryPack(bad)).toThrow(/"orphan" is never cited/);
  });

  it("rejects a band whose passing flag disagrees with the pass mark", () => {
    const bad = clone(AL_INPUT);
    bad.gradingScales[0]!.bands[0]!.passing = true;
    expect(() => validateCountryPack(bad)).toThrow(/disagrees with passMark/);
  });

  it("rejects a grade that appears in two stages", () => {
    const bad = clone(AE_INPUT);
    bad.grades[2]!.grades = ["4", "5", "6", "7", "8"];
    expect(() => validateCountryPack(bad)).toThrow(/grade "4" appears in more than one stage/);
  });

  it("rejects an exam window outside its months", () => {
    const bad = clone(AL_INPUT);
    bad.examCalendars[0]!.exams[0]!.months = [5];
    expect(() => validateCountryPack(bad)).toThrow(/window date 2027-06-07 is outside months/);
  });

  it("rejects a non-https source URL", () => {
    const bad = clone(AL_INPUT);
    bad.sources[0]!.url = "http://example.com";
    expect(() => validateCountryPack(bad)).toThrow(/sources\.0\.url/);
  });

  it("rejects a primary language the pack does not offer", () => {
    const bad = clone(AL_INPUT);
    bad.defaultLanguages.primary = "ar";
    expect(() => validateCountryPack(bad)).toThrow(/"ar" is not in supportedLocales/);
  });
});

describe("resolveTenantLocale", () => {
  it("keeps a tenant locale its pack supports", () => {
    expect(resolveTenantLocale({ tenantLocale: "ar", countryCode: "AE" })).toBe("ar");
  });
  it("falls back to the pack's primary language for a missing or unsupported locale", () => {
    expect(resolveTenantLocale({ tenantLocale: null, countryCode: "AL" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "ar", countryCode: "AL" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "xx", countryCode: "AE" })).toBe("en");
  });
  it("without a known pack, returns a valid tenant locale or null", () => {
    expect(resolveTenantLocale({ tenantLocale: "sq", countryCode: "ZZ" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "xx" })).toBeNull();
  });
});
