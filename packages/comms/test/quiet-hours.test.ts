import { describe, expect, it } from "vitest";

import { deliveryTime, isQuietAt, minuteOfDayIn, quietHoursEndAfter } from "../src/quiet-hours";

const NIGHT = { startMinute: 21 * 60, endMinute: 7 * 60 }; // 21:00–07:00, wraps midnight
const LUNCH = { startMinute: 12 * 60, endMinute: 13 * 60 }; // same-day window

describe("quiet hours", () => {
  it("reads the wall clock in the given zone", () => {
    const at = new Date("2026-11-09T19:30:00Z");
    expect(minuteOfDayIn(at, "Europe/Tirane")).toBe(20 * 60 + 30); // CET, UTC+1
    expect(minuteOfDayIn(at, "Asia/Dubai")).toBe(23 * 60 + 30); // UTC+4
  });

  it("the same instant is quiet in Abu Dhabi but not in Tirana", () => {
    const at = new Date("2026-11-09T19:30:00Z");
    expect(isQuietAt(at, NIGHT, "Europe/Tirane")).toBe(false);
    expect(isQuietAt(at, NIGHT, "Asia/Dubai")).toBe(true);
  });

  it("windows are [start, end) and wrap midnight; start = end or null means none", () => {
    const z = "UTC";
    expect(isQuietAt(new Date("2026-11-09T21:00:00Z"), NIGHT, z)).toBe(true);
    expect(isQuietAt(new Date("2026-11-09T03:00:00Z"), NIGHT, z)).toBe(true);
    expect(isQuietAt(new Date("2026-11-09T07:00:00Z"), NIGHT, z)).toBe(false);
    expect(isQuietAt(new Date("2026-11-09T20:59:00Z"), NIGHT, z)).toBe(false);
    expect(isQuietAt(new Date("2026-11-09T12:30:00Z"), LUNCH, z)).toBe(true);
    expect(isQuietAt(new Date("2026-11-09T13:00:00Z"), LUNCH, z)).toBe(false);
    expect(isQuietAt(new Date("2026-11-09T12:30:00Z"), { startMinute: 600, endMinute: 600 }, z)).toBe(false);
    expect(isQuietAt(new Date("2026-11-09T12:30:00Z"), null, z)).toBe(false);
  });

  it("defers to the local end of quiet hours, across a DST change", () => {
    // Abu Dhabi 23:30 -> 07:00 local = 03:00Z.
    expect(quietHoursEndAfter(new Date("2026-11-09T19:30:00Z"), NIGHT, "Asia/Dubai").toISOString()).toBe(
      "2026-11-10T03:00:00.000Z",
    );
    // Tirana 22:00 CEST on 24 Oct; clocks go back overnight, so 07:00 CET = 06:00Z.
    expect(quietHoursEndAfter(new Date("2026-10-24T20:00:00Z"), NIGHT, "Europe/Tirane").toISOString()).toBe(
      "2026-10-25T06:00:00.000Z",
    );
    const awake = new Date("2026-11-09T10:00:00Z");
    expect(quietHoursEndAfter(awake, NIGHT, "Europe/Tirane")).toBe(awake);
  });

  it("critical alerts bypass quiet hours unless the preference says otherwise", () => {
    const now = new Date("2026-11-09T19:30:00Z");
    const base = { now, timeZone: "Asia/Dubai", quiet: NIGHT };
    expect(deliveryTime(base)).toEqual({ at: new Date("2026-11-10T03:00:00Z"), deferred: true });
    expect(deliveryTime({ ...base, critical: true })).toEqual({ at: now, deferred: false });
    expect(deliveryTime({ ...base, critical: true, criticalBypassesQuiet: false }).deferred).toBe(true);
  });

  it("rejects an unknown time zone instead of silently using UTC", () => {
    expect(() => isQuietAt(new Date(), NIGHT, "Mars/Olympus")).toThrow(RangeError);
  });
});
