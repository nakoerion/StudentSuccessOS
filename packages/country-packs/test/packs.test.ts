import { describe, expect, it } from "vitest";

import {
  AE,
  AL,
  countryPacks,
  countryPackSchema,
  type CountryPackInput,
  packConfirmationItems,
  resolveTenantLocale,
  validateCountryPack,
} from "../src";
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

  it("UAE: KG + cycles 1–4 / 5–8 / 9–12; 0–100 pass 60; EmSAT discontinued; ar (RTL) primary + en", () => {
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
    expect(AE.defaultLanguages).toMatchObject({ primary: "ar", secondary: ["en"] });
  });
});

describe("owner policy decisions (2026-10-26)", () => {
  it("data-consent age is 16 in both packs; medical consent 18 in both; each cited and flagged for local counsel", () => {
    for (const pack of [AL, AE]) {
      const { dataProcessing, medical } = pack.consentAges;
      expect([pack.code, dataProcessing.minAge, medical.minAge]).toEqual([pack.code, 16, 18]);
      for (const rule of [dataProcessing, medical]) {
        expect(rule.sourceIds.length).toBeGreaterThan(0);
        expect(rule.needsConfirmation?.by).toBe("local-counsel");
      }
      expect(dataProcessing.needsConfirmation?.note).toMatch(/lawful basis/);
    }
    expect(AL.consentAges.dataProcessing.sourceIds).toEqual(["al-law-124-2024", "al-dla-piper-consent-16"]);
    expect(AE.consentAges.dataProcessing.sourceIds).toEqual(
      expect.arrayContaining(["ae-pdpl-no-minor-age", "ae-cds-parental-consent-13"]),
    );
    expect(AL.consentAges.medical.needsConfirmation?.note).toMatch(/10107\/2009/);
  });

  it("UAE: Arabic is the primary (RTL) language with English as the toggle; u.ae cited", () => {
    expect(AE.defaultLanguages.primary).toBe("ar");
    expect(AE.defaultLanguages.secondary).toEqual(["en"]);
    expect(AE.defaultLanguages.sourceIds).toContain("ae-portal-language");
    expect(AE.sources.find((s) => s.id === "ae-portal-language")?.url).toMatch(/^https:\/\/u\.ae\//);
  });

  it("UAE: MOE 2026-27 calendar = 3 terms, 67 + 60 + 58 = 185 school days, mid-term break 12–16 Oct, exclusions recorded", () => {
    const cal = AE.examCalendars[0]!;
    expect(cal.terms.map((t) => [t.key, t.nameEn, t.start, t.end, t.schoolDays])).toEqual([
      ["term-1", "Term 1", "2026-08-31", "2026-12-11", 67],
      ["term-2", "Term 2", "2027-01-04", "2027-04-02", 60],
      ["term-3", "Term 3", "2027-04-12", "2027-07-02", 58],
    ]);
    expect(cal.schoolDays).toBe(185);
    expect(cal.breaks).toEqual([expect.objectContaining({ start: "2026-10-12", end: "2026-10-16" })]);
    expect(cal.notes).toMatch(/Indian, Bangladeshi or Pakistani/);
    expect(cal.notes).toMatch(/Sharjah/);
    expect(cal.sourceIds).toContain("ae-moe-calendar-2026-2029");
  });

  it("UAE grading scale is a configurable default that needs school confirmation, not an authoritative scale", () => {
    for (const scale of AE.gradingScales) expect(scale.needsConfirmation?.by).toBe("school");
  });

  it("Albania keeps 2 semesters as wizard placeholders: no pack terms, calendar flagged for school confirmation", () => {
    const cal = AL.examCalendars[0]!;
    expect(cal.terms).toEqual([]);
    expect(cal.needsConfirmation?.by).toBe("school");
  });

  it("packConfirmationItems lists every flagged fact", () => {
    expect(packConfirmationItems(AL).map((i) => [i.path, i.by])).toEqual([
      ["consentAges.dataProcessing", "local-counsel"],
      ["consentAges.medical", "local-counsel"],
      ["examCalendars.2026-2027", "school"],
    ]);
    expect(packConfirmationItems(AE).map((i) => [i.path, i.by])).toEqual([
      ["consentAges.dataProcessing", "local-counsel"],
      ["consentAges.medical", "local-counsel"],
      ["gradingScales.ae-moe-percentage", "school"],
      ["examCalendars.2026-2027", "school"],
    ]);
  });
});

describe("grade-scale conversion bands (pack 1.2.0)", () => {
  it("AL 4–10: cut-offs 0/45/55/65/75/85/95 + NAIA/NCAA GPA; AE: A/B/C/D/F at 90/80/70/60, GPA 4–0; both carry a conversionNote", () => {
    expect([AL.version, AE.version]).toEqual(["1.2.0", "1.2.0"]);
    const al = AL.gradingScales[0]!;
    expect(al.bands.map((b) => [b.label, b.pctMin, b.gpa])).toEqual([
      ["4", 0, 0],
      ["5", 45, 2],
      ["6", 55, 2],
      ["7", 65, 3],
      ["8", 75, 3],
      ["9", 85, 4],
      ["10", 95, 4],
    ]);
    expect(al.conversionNote).toMatch(/school must confirm/);
    expect(al.conversionNote).toMatch(/NAIA\/NCAA/);
    const ae = AE.gradingScales[0]!;
    expect(ae.bands.map((b) => [b.label, b.min, b.gpa, b.passing])).toEqual([
      ["F", 0, 0, false],
      ["D", 60, 1, true],
      ["C", 70, 2, true],
      ["B", 80, 3, true],
      ["A", 90, 4, true],
    ]);
    expect(ae.conversionNote).toMatch(/school must confirm/);
    expect(ae.conversionNote).toMatch(/does not publish/);
    // No new source was invented for the conversions.
    expect(AL.sources).toHaveLength(AL_INPUT.sources.length);
    expect(ae.sourceIds).toEqual(["ae-moe-assessment-2026-27"]);
  });

  it("rejects partial gpa/pctMin, non-rising pctMin or gpa, a numeric scale without pctMin, and bands without a conversionNote", () => {
    const errorsOf = (mutate: (p: CountryPackInput) => void) => {
      const bad = clone(AL_INPUT);
      mutate(bad);
      const r = countryPackSchema.safeParse(bad);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    const bands = (p: CountryPackInput) => p.gradingScales[0]!.bands;
    expect(errorsOf(() => {})).toEqual([]);
    expect(errorsOf((p) => delete bands(p)[3]!.gpa)).toContain("gpa must be set on every band or on none");
    expect(errorsOf((p) => (bands(p)[2]!.pctMin = 40))).toContain("pctMin must rise strictly with the band");
    expect(errorsOf((p) => (bands(p)[6]!.gpa = 1))).toContain("gpa must not fall as the band rises");
    expect(errorsOf((p) => (bands(p)[0]!.pctMin = 5))).toContain("the lowest band's pctMin must be 0");
    expect(
      errorsOf((p) => {
        for (const b of bands(p)) delete b.pctMin;
      }),
    ).toContain("pctMin is required on every band of a numeric scale");
    expect(errorsOf((p) => delete p.gradingScales[0]!.conversionNote)).toContain("bands with pctMin/gpa need a conversionNote");
    // A percentage scale may omit pctMin (defaults to min), but still needs the note when gpa is set.
    const ae = clone(AE_INPUT);
    expect(countryPackSchema.safeParse(ae).success).toBe(true);
    delete ae.gradingScales[0]!.conversionNote;
    expect(countryPackSchema.safeParse(ae).success).toBe(false);
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

  it("rejects term schoolDays that do not add up, overlapping terms, and a break outside every term", () => {
    const days = clone(AE_INPUT);
    days.examCalendars[0]!.schoolDays = 180;
    expect(() => validateCountryPack(days)).toThrow(/term schoolDays sum to 185, calendar says 180/);
    const overlap = clone(AE_INPUT);
    overlap.examCalendars[0]!.terms[1]!.start = "2026-12-01";
    expect(() => validateCountryPack(overlap)).toThrow(/term "term-2" must start after "term-1" ends/);
    const brk = clone(AE_INPUT);
    brk.examCalendars[0]!.breaks![0]!.end = "2027-01-10";
    expect(() => validateCountryPack(brk)).toThrow(/break "term-1-mid-term" must lie within a single term/);
  });

  it("rejects an unknown needsConfirmation party", () => {
    const bad = clone(AL_INPUT) as unknown as { consentAges: { medical: { needsConfirmation: { by: string } } } };
    bad.consentAges.medical.needsConfirmation.by = "anyone";
    expect(() => validateCountryPack(bad)).toThrow(/consentAges\.medical\.needsConfirmation\.by/);
  });

  it("accepts optional subjects and default categories, and rejects bad ones", () => {
    const src = AL_INPUT.sources[0]!.id;
    const good = clone(AL_INPUT);
    good.subjects = [{ key: "matematike", code: "MAT", name: "Matematikë", nameEn: "Mathematics", grades: ["10"], sourceIds: [src] }];
    good.gradingScales[0]!.defaultCategories = [
      { key: "oral", name: "Me gojë", nameEn: "Oral", weight: 40 },
      { key: "written", name: "Me shkrim", nameEn: "Written", weight: 60 },
    ];
    good.gradingScales[0]!.categoriesSourceIds = [src];
    expect(validateCountryPack(good).subjects).toHaveLength(1);

    const badWeights = clone(good);
    badWeights.gradingScales[0]!.defaultCategories![0]!.weight = 30;
    expect(() => validateCountryPack(badWeights)).toThrow(/weights must sum to 100 \(got 90\)/);

    const uncited = clone(good);
    delete uncited.gradingScales[0]!.categoriesSourceIds;
    expect(() => validateCountryPack(uncited)).toThrow(/defaultCategories need categoriesSourceIds/);

    const dupe = clone(good);
    dupe.subjects!.push({ ...dupe.subjects![0]!, key: "matematike-2" });
    expect(() => validateCountryPack(dupe)).toThrow(/duplicate subject code "MAT"/);

    const badGrade = clone(good);
    badGrade.subjects![0]!.grades = ["13"];
    expect(() => validateCountryPack(badGrade)).toThrow(/unknown grade "13"/);
  });
});

describe("resolveTenantLocale", () => {
  it("keeps a tenant locale its pack supports (e.g. an English-medium UAE school)", () => {
    expect(resolveTenantLocale({ tenantLocale: "ar", countryCode: "AE" })).toBe("ar");
    expect(resolveTenantLocale({ tenantLocale: "en", countryCode: "AE" })).toBe("en");
  });
  it("falls back to the pack's primary language for a missing or unsupported locale", () => {
    expect(resolveTenantLocale({ tenantLocale: null, countryCode: "AL" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "ar", countryCode: "AL" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "xx", countryCode: "AE" })).toBe("ar");
    expect(resolveTenantLocale({ tenantLocale: null, countryCode: "AE" })).toBe("ar");
  });
  it("without a known pack, returns a valid tenant locale or null", () => {
    expect(resolveTenantLocale({ tenantLocale: "sq", countryCode: "ZZ" })).toBe("sq");
    expect(resolveTenantLocale({ tenantLocale: "xx" })).toBeNull();
  });
});
