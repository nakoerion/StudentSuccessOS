import { getCountryPack, packDefaultLocale, validateCountryPack } from "@ssos/country-packs";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedId } from "../seed/deterministic";
import { TENANTS } from "../seed/fixtures";
import { withTenant } from "../src/with-tenant";
import { appClient } from "./helpers";

let app: PrismaClient;

beforeAll(() => {
  app = appClient();
});

afterAll(async () => {
  await app.$disconnect();
});

describe("seeded tenants carry their country pack", () => {
  it("fixtures map Liceu Demo Tiranë -> AL and Demo School Abu Dhabi -> AE", () => {
    expect(TENANTS.map((t) => [t.name, t.countryCode])).toEqual([
      ["Liceu Demo Tiranë", "AL"],
      ["Demo School Abu Dhabi", "AE"],
    ]);
  });

  it.each(TENANTS.map((t) => [t.slug, t] as const))(
    "%s: tenant row references its pack and default_locale/timezone come from it (read as ssos_app)",
    async (_slug, fixture) => {
      const tenantId = seedId("tenant", fixture.slug);
      const pack = getCountryPack(fixture.countryCode);
      const row = await withTenant(
        tenantId,
        (tx) =>
          tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { defaultLocale: true, timezone: true, countryPack: { select: { code: true, version: true, data: true } } },
          }),
        { client: app },
      );
      expect(row.countryPack.code).toBe(fixture.countryCode);
      expect(row.countryPack.version).toBe(pack.version);
      expect(row.defaultLocale).toBe(packDefaultLocale(pack));
      expect(row.timezone).toBe(pack.defaultTimezone);
      // The stored pack payload is the validated pack, and still validates.
      expect(validateCountryPack(row.countryPack.data).sources).toEqual(pack.sources);
    },
  );

  it("each pack's default grading scales are seeded, and only those", async () => {
    for (const fixture of TENANTS) {
      const tenantId = seedId("tenant", fixture.slug);
      const pack = getCountryPack(fixture.countryCode);
      const scales = await withTenant(
        tenantId,
        (tx) =>
          tx.gradeScale.findMany({
            where: { tenantId: null, countryPack: { code: fixture.countryCode } },
            select: { key: true, passMark: true },
          }),
        { client: app },
      );
      expect(scales.map((s) => [s.key, Number(s.passMark)])).toEqual(pack.gradingScales.map((s) => [s.key, s.passMark]));
    }
  });
});
