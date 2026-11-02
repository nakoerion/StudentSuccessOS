/**
 * Gradebook conversions (slice 4a): pure golden cases + boundary values for both packs.
 * GPA on the Albanian 4–10 scale follows the NAIA/NCAA reference table:
 * 10→4.0, 9→4.0, 8→3.0, 7→3.0, 6→2.0, 5→2.0, 4→0.
 */
import { AE, AL } from "@ssos/country-packs";
import { describe, expect, it } from "vitest";

import {
  bandForPercentage,
  convertPercentage,
  equalWeightedMean,
  percentageToGpa,
  percentageToMatura,
  percentageToScaleValue,
  scaleValueToGpa,
  scaleValueToMatura,
  scaleValueToPercentage,
  toScaleDef,
  weightedPercentage,
} from "../src/gradebook";

const al = toScaleDef(AL.gradingScales[0]!);
const ae = toScaleDef(AE.gradingScales[0]!);

describe("gradebook conversions: scale definitions", () => {
  it("toScaleDef reads pack scales and grade_scale rows (Decimal strings) identically; pctMin defaults to min on percentage scales", () => {
    const s = AL.gradingScales[0]!;
    const fromRow = toScaleDef({ kind: s.kind, minValue: "4.00", maxValue: "10.00", passMark: "5.00", bands: s.bands });
    expect(fromRow).toEqual(al);
    expect(al).toMatchObject({ kind: "numeric", min: 4, max: 10, passMark: 5 });
    expect(al.bands.map((b) => b.pctMin)).toEqual([0, 45, 55, 65, 75, 85, 95]);
    expect(ae.bands.map((b) => [b.label, b.pctMin])).toEqual([
      ["F", 0],
      ["D", 60],
      ["C", 70],
      ["B", 80],
      ["A", 90],
    ]);
  });
});

describe("gradebook conversions: Albania 4–10", () => {
  it("percentage → mark at every cut-off (0/45/55/65/75/85/95) and just below it", () => {
    const cases: [number, number][] = [
      [0, 4], [44.99, 4], [45, 5], [54.99, 5], [55, 6], [64.99, 6], [65, 7],
      [74.99, 7], [75, 8], [84.99, 8], [85, 9], [94.99, 9], [95, 10], [100, 10],
    ];
    for (const [pct, mark] of cases) expect([pct, percentageToScaleValue(al, pct)]).toEqual([pct, mark]);
  });

  it("mark → percentage is mark ÷ 10 × 100; out-of-scale marks are rejected", () => {
    expect([4, 5, 7, 7.5, 8.25, 10].map((m) => scaleValueToPercentage(al, m))).toEqual([40, 50, 70, 75, 82.5, 100]);
    // Round trip lands in the same band for every whole mark.
    for (let m = 4; m <= 10; m++) expect(percentageToScaleValue(al, scaleValueToPercentage(al, m))).toBe(m);
    expect(() => scaleValueToPercentage(al, 3.99)).toThrow(RangeError);
    expect(() => scaleValueToPercentage(al, 10.01)).toThrow(RangeError);
  });

  it("GPA follows the NAIA/NCAA table: 10→4.0, 9→4.0, 8→3.0, 7→3.0, 6→2.0, 5→2.0, 4→0", () => {
    expect([10, 9, 8, 7, 6, 5, 4].map((m) => scaleValueToGpa(al, m))).toEqual([4, 4, 3, 3, 2, 2, 0]);
  });

  it("percentage → GPA at the band boundaries", () => {
    const cases: [number, number][] = [[0, 0], [44.99, 0], [45, 2], [64.99, 2], [65, 3], [84.99, 3], [85, 4], [100, 4]];
    for (const [pct, gpa] of cases) expect([pct, percentageToGpa(al, pct)]).toEqual([pct, gpa]);
  });

  it("Matura-equivalent equals the mark on the 4–10 scale (pass 5 → 5, max 10 → 10, below pass → 4)", () => {
    expect([4, 5, 6, 7, 7.5, 8, 9, 10].map((m) => scaleValueToMatura(al, m))).toEqual([4, 5, 6, 7, 7.5, 8, 9, 10]);
    expect(scaleValueToMatura(al, 4.99)).toBe(4);
    expect(percentageToMatura(al, 74.99)).toBe(7);
    expect(percentageToMatura(al, 75)).toBe(8);
  });
});

describe("gradebook conversions: UAE 0–100", () => {
  it("percentage scale: mark ↔ percentage is the identity", () => {
    for (const v of [0, 59.99, 60, 87.48, 100]) {
      expect(percentageToScaleValue(ae, v)).toBe(v);
      expect(scaleValueToPercentage(ae, v)).toBe(v);
    }
  });

  it("letter bands A/B/C/D/F at 90/80/70/60, pass from 60", () => {
    const cases: [number, string, boolean][] = [
      [0, "F", false], [59.99, "F", false], [60, "D", true], [69.99, "D", true], [70, "C", true],
      [79.99, "C", true], [80, "B", true], [89.99, "B", true], [90, "A", true], [100, "A", true],
    ];
    for (const [pct, label, passing] of cases) {
      const b = bandForPercentage(ae, pct);
      expect([pct, b.label, b.passing]).toEqual([pct, label, passing]);
    }
  });

  it("GPA 4/3/2/1/0 for A/B/C/D/F", () => {
    expect([95, 85, 75, 65, 55].map((p) => percentageToGpa(ae, p))).toEqual([4, 3, 2, 1, 0]);
    expect([90, 80, 70, 60, 59.99].map((p) => scaleValueToGpa(ae, p))).toEqual([4, 3, 2, 1, 0]);
  });

  it("Matura-equivalent: straight line 60 → 5 … 100 → 10, below 60 → 4, rounded half-up to 2 dp", () => {
    expect(scaleValueToMatura(ae, 60)).toBe(5);
    expect(scaleValueToMatura(ae, 100)).toBe(10);
    expect(scaleValueToMatura(ae, 80)).toBe(7.5);
    expect(scaleValueToMatura(ae, 87.48)).toBe(8.44); // 5 + 27.48 × 5 ÷ 40 = 8.435
    expect(scaleValueToMatura(ae, 59.99)).toBe(4);
    expect(percentageToMatura(ae, 0)).toBe(4);
  });
});

describe("gradebook conversions: convertPercentage + arithmetic", () => {
  it("convertPercentage returns value, label, pass/fail, GPA and Matura together (golden, both packs)", () => {
    expect(convertPercentage(al, 75)).toEqual({ percentage: 75, value: 8, label: "8", passing: true, gpa: 3, matura: 8 });
    expect(convertPercentage(al, 44.99)).toEqual({ percentage: 44.99, value: 4, label: "4", passing: false, gpa: 0, matura: 4 });
    expect(convertPercentage(al, 94)).toEqual({ percentage: 94, value: 9, label: "9", passing: true, gpa: 4, matura: 9 });
    expect(convertPercentage(ae, 87.48)).toEqual({ percentage: 87.48, value: 87.48, label: "B", passing: true, gpa: 3, matura: 8.44 });
    // The input is rounded half-up to 2 dp before banding: 59.995 → 60.00 → D (pass).
    expect(convertPercentage(ae, 59.995)).toMatchObject({ percentage: 60, label: "D", passing: true, gpa: 1, matura: 5 });
    expect(convertPercentage(ae, 59.994)).toMatchObject({ percentage: 59.99, label: "F", passing: false, gpa: 0, matura: 4 });
  });

  it("weightedPercentage is exact and rounds half-up: 74.995 → 75 (not float 74.99), 74.994 → 74.99; weights need not sum to 100", () => {
    expect(weightedPercentage([{ average: 74.9, weight: 1 }, { average: 75, weight: 19 }])).toBe(75);
    expect(weightedPercentage([{ average: 74.9, weight: 3 }, { average: 75, weight: 47 }])).toBe(74.99);
    expect(weightedPercentage([{ average: 80, weight: 2 }, { average: 70, weight: 1 }, { average: 60, weight: 1 }])).toBe(72.5);
    expect(weightedPercentage([{ average: 80, weight: 40 }, { average: 70, weight: 30 }, { average: 90, weight: 30 }])).toBe(80);
    expect(weightedPercentage([{ average: 1.005, weight: 1 }])).toBe(1.01); // float Math.round would give 1
    expect(weightedPercentage([{ average: "66.665", weight: "0.5" }, { average: 66.665, weight: 0 }])).toBe(66.67);
  });

  it("weightedPercentage rejects empty input, zero total weight and negative weights; equalWeightedMean is exact", () => {
    expect(() => weightedPercentage([])).toThrow(RangeError);
    expect(() => weightedPercentage([{ average: 80, weight: 0 }])).toThrow(/total weight/);
    expect(() => weightedPercentage([{ average: 80, weight: -1 }, { average: 80, weight: 2 }])).toThrow(RangeError);
    expect(equalWeightedMean([73, 94])).toBe(83.5);
    expect(equalWeightedMean([90, 84.96])).toBe(87.48);
    expect(equalWeightedMean([90, 84.96, 58.98])).toBe(77.98);
    expect(equalWeightedMean([0.01, 0.02])).toBe(0.02); // 0.015 half-up
    expect(equalWeightedMean([])).toBeNull();
  });

  it("percentages outside 0..100 throw; a hand-made scale without gpa/pctMin falls back to mark ÷ max × 100 and null GPA", () => {
    for (const bad of [-0.01, 100.01, Number.NaN]) {
      expect(() => bandForPercentage(al, bad)).toThrow(RangeError);
      expect(() => convertPercentage(ae, bad)).toThrow(RangeError);
    }
    const custom = toScaleDef({
      kind: "letter",
      min: 0,
      max: 4,
      passMark: 2,
      bands: [
        { min: 0, max: 1, label: "E", passing: false },
        { min: 2, max: 2, label: "C", passing: true },
        { min: 3, max: 4, label: "A", passing: true },
      ],
    });
    expect(custom.bands.map((b) => b.pctMin)).toEqual([0, 50, 75]);
    expect(convertPercentage(custom, 80)).toEqual({ percentage: 80, value: 3, label: "A", passing: true, gpa: null, matura: 7.5 });
    expect(convertPercentage(custom, 49.99)).toMatchObject({ value: 0, label: "E", passing: false, matura: 4 });
  });
});
