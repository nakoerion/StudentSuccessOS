import type { MembershipRow } from "@ssos/db";
import { describe, expect, it } from "vitest";

import { resolveTenantLocale } from "@ssos/country-packs";
import { chooseLocale, dirFor, negotiateLocale } from "../i18n/config";
import { groupMemberships, landingPath, membershipForSlug, resolveLanding } from "../lib/tenancy";

const row = (over: Partial<MembershipRow>): MembershipRow => ({
  tenantId: "t-a",
  tenantSlug: "school-a",
  tenantName: "School A",
  defaultLocale: "sq",
  countryCode: "AL",
  personId: "p-a",
  roleKey: "teacher",
  status: "active",
  ...over,
});
const B = { tenantId: "t-b", tenantSlug: "school-b", tenantName: "School B", defaultLocale: "en", countryCode: "AE", personId: "p-b" };

describe("resolveLanding", () => {
  it("0 memberships -> Join your school", () => {
    expect(resolveLanding([])).toEqual({ kind: "join" });
    expect(landingPath(resolveLanding([]))).toBe("/join");
  });

  it("a person with no role counts as no membership", () => {
    expect(resolveLanding([row({ roleKey: null, status: null })])).toEqual({ kind: "join" });
  });

  it("only pending claims -> waiting for approval (on /join)", () => {
    const landing = resolveLanding([row({ status: "pending", roleKey: "parent" })]);
    expect(landing.kind).toBe("pending");
    expect(landing.kind === "pending" && landing.schools[0]?.pendingRoles).toEqual(["parent"]);
    expect(landingPath(landing)).toBe("/join");
  });

  it("1 active membership -> straight to that school (several roles, one tenant)", () => {
    const landing = resolveLanding([row({ roleKey: "teacher" }), row({ roleKey: "parent" })]);
    expect(landing).toEqual({ kind: "tenant", slug: "school-a" });
    expect(landingPath(landing)).toBe("/t/school-a");
  });

  it("an active membership wins over a pending claim elsewhere", () => {
    expect(resolveLanding([row({}), row({ ...B, status: "pending", roleKey: "student" })])).toEqual({
      kind: "tenant",
      slug: "school-a",
    });
  });

  it("more than 1 active membership -> school picker, sorted by name", () => {
    const landing = resolveLanding([row({ ...B }), row({})]);
    expect(landing.kind).toBe("picker");
    expect(landing.kind === "picker" && landing.schools.map((s) => s.slug)).toEqual(["school-a", "school-b"]);
    expect(landingPath(landing)).toBe("/schools");
  });
});

describe("membershipForSlug", () => {
  it("returns the membership only where the user is active", () => {
    const rows = [row({}), row({ ...B, status: "pending" })];
    expect(membershipForSlug(rows, "school-a")?.activeRoles).toEqual(["teacher"]);
    expect(membershipForSlug(rows, "school-b")).toBeNull();
    expect(membershipForSlug(rows, "unknown")).toBeNull();
  });

  it("groups roles per tenant without duplicates", () => {
    const g = groupMemberships([row({}), row({}), row({ roleKey: "admin" })]);
    expect(g).toHaveLength(1);
    expect(g[0]?.activeRoles.sort()).toEqual(["admin", "teacher"]);
  });
});

describe("locale choice", () => {
  it("cookie > tenant default > account > Accept-Language > en", () => {
    expect(chooseLocale({ cookie: "ar", tenantDefault: "sq" })).toBe("ar");
    expect(chooseLocale({ cookie: "xx", tenantDefault: "sq" })).toBe("sq");
    expect(chooseLocale({ account: "sq", acceptLanguage: "ar" })).toBe("sq");
    expect(chooseLocale({ acceptLanguage: "de-DE,ar;q=0.8,en;q=0.5" })).toBe("ar");
    expect(chooseLocale({})).toBe("en");
  });
  it("tenant default comes from the country pack when the tenant's own locale is unusable", () => {
    const tenantDefault = (tenantLocale: string | null, countryCode: string) =>
      resolveTenantLocale({ tenantLocale, countryCode });
    expect(chooseLocale({ tenantDefault: tenantDefault("sq", "AL"), acceptLanguage: "en" })).toBe("sq");
    expect(chooseLocale({ tenantDefault: tenantDefault(null, "AL"), acceptLanguage: "en" })).toBe("sq");
    expect(chooseLocale({ tenantDefault: tenantDefault("ar", "AL"), acceptLanguage: "en" })).toBe("sq");
    expect(chooseLocale({ tenantDefault: tenantDefault("xx", "AE"), acceptLanguage: "sq" })).toBe("ar"); // AE pack default is Arabic
    expect(chooseLocale({ tenantDefault: tenantDefault("en", "AE") })).toBe("en"); // English-medium override
    expect(chooseLocale({ tenantDefault: tenantDefault("ar", "AE") })).toBe("ar");
    // Unknown pack and no valid locale -> falls through to account / Accept-Language / en.
    expect(chooseLocale({ tenantDefault: tenantDefault("xx", "ZZ"), acceptLanguage: "ar" })).toBe("ar");
  });

  it("negotiates base tags and only RTL for ar", () => {
    expect(negotiateLocale("sq-AL")).toBe("sq");
    expect(negotiateLocale("fr")).toBeNull();
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("sq")).toBe("ltr");
  });
});
