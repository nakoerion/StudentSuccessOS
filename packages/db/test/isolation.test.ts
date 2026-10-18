import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../src/with-tenant";
import { appClient, EXPECTED, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

let app: PrismaClient;
let owner: PrismaClient;

beforeAll(() => {
  app = appClient();
  owner = ownerClient();
});
afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe("runtime role", () => {
  it("connects as ssos_app, which is neither superuser nor BYPASSRLS", async () => {
    const [row] = await app.$queryRaw<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
    expect(row).toEqual({ current_user: "ssos_app", rolsuper: false, rolbypassrls: false });
  });
});

describe("tenant isolation (reads)", () => {
  for (const [label, tenantId, otherId] of [
    ["A (Tirana)", TENANT_A, TENANT_B],
    ["B (Abu Dhabi)", TENANT_B, TENANT_A],
  ] as const) {
    it(`tenant ${label} sees only its own person / role_assignment / guardianship rows`, async () => {
      const result = await withTenant(
        tenantId,
        async (tx) => ({
          persons: await tx.person.findMany({ select: { tenantId: true } }),
          assignments: await tx.roleAssignment.findMany({ select: { tenantId: true } }),
          guardianships: await tx.guardianship.findMany({ select: { tenantId: true } }),
          otherTenantPersons: await tx.person.count({ where: { tenantId: otherId } }),
        }),
        { client: app },
      );

      expect(result.persons).toHaveLength(EXPECTED.persons);
      expect(result.assignments).toHaveLength(EXPECTED.roleAssignments);
      expect(result.guardianships).toHaveLength(EXPECTED.guardianships);
      for (const rows of [result.persons, result.assignments, result.guardianships]) {
        expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([tenantId]));
      }
      expect(result.otherTenantPersons).toBe(0);
    });
  }

  it("counts under RLS match the owner's view of the seed", async () => {
    const ownerCount = await owner.person.count({ where: { tenantId: TENANT_A } });
    const appCount = await withTenant(TENANT_A, (tx) => tx.person.count(), { client: app });
    expect(appCount).toBe(ownerCount);
    expect(appCount).toBe(EXPECTED.persons);
  });

  it("a known id from tenant B is invisible from tenant A", async () => {
    const bPerson = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B } });
    const seen = await withTenant(TENANT_A, (tx) => tx.person.findUnique({ where: { id: bPerson.id } }), {
      client: app,
    });
    expect(seen).toBeNull();
  });

  it("system roles (tenant_id NULL) are readable by every tenant", async () => {
    const keys = await withTenant(TENANT_A, (tx) => tx.role.findMany({ select: { key: true, tenantId: true } }), {
      client: app,
    });
    expect(keys.map((k) => k.key).sort()).toEqual(["admin", "advisor", "parent", "student", "teacher", "trainer"]);
    expect(keys.every((k) => k.tenantId === null)).toBe(true);
  });
});

describe("tenant isolation (writes)", () => {
  it("rejects INSERT with another tenant's tenant_id", async () => {
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.person.create({
            data: { tenantId: TENANT_B, givenName: "Cross", familyName: "Tenant", displayName: "Cross Tenant" },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects UPDATE that moves an own row into another tenant", async () => {
    const aPerson = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A } });
    await expect(
      withTenant(
        TENANT_A,
        (tx) => tx.person.update({ where: { id: aPerson.id }, data: { tenantId: TENANT_B } }),
        { client: app },
      ),
    ).rejects.toThrow(/row-level security/);
    const after = await owner.person.findUniqueOrThrow({ where: { id: aPerson.id } });
    expect(after.tenantId).toBe(TENANT_A);
  });

  it("UPDATE / DELETE aimed at another tenant's rows affect nothing", async () => {
    const before = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B }, orderBy: { id: "asc" } });
    const { updated, deleted } = await withTenant(
      TENANT_A,
      async (tx) => ({
        updated: (await tx.person.updateMany({ where: { tenantId: TENANT_B }, data: { givenName: "Hacked" } })).count,
        deleted: (await tx.guardianship.deleteMany({ where: { tenantId: TENANT_B } })).count,
      }),
      { client: app },
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    const after = await owner.person.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.givenName).toBe(before.givenName);
    expect(await owner.guardianship.count({ where: { tenantId: TENANT_B } })).toBe(EXPECTED.guardianships);
  });

  it("rejects an own-tenant row that references another tenant's person (composite FK)", async () => {
    const bStudent = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_B, externalRef: "S-001" } });
    const aParent = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A, externalRef: "P-001" } });
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.guardianship.create({
            data: {
              tenantId: TENANT_A,
              guardianPersonId: aParent.id,
              studentPersonId: bStudent.id,
              relationship: "guardian",
            },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it("cannot modify system roles", async () => {
    const count = await withTenant(
      TENANT_A,
      async (tx) => (await tx.role.updateMany({ where: { tenantId: null }, data: { name: "Pwned" } })).count,
      { client: app },
    );
    expect(count).toBe(0);
  });

  it("positive control: own-tenant INSERT succeeds (then rolls back)", async () => {
    await expect(
      withTenant(
        TENANT_A,
        async (tx) => {
          const p = await tx.person.create({
            data: { tenantId: TENANT_A, givenName: "Test", familyName: "Person", displayName: "Test Person" },
          });
          expect(p.tenantId).toBe(TENANT_A);
          expect(await tx.person.count()).toBe(EXPECTED.persons + 1);
          throw new Rollback();
        },
        { client: app },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await owner.person.count({ where: { tenantId: TENANT_A } })).toBe(EXPECTED.persons);
  });
});

describe("no tenant set", () => {
  const strictTables = [
    "tenant_unit",
    "tenant_setting",
    "person",
    "role_assignment",
    "guardianship",
    "consent",
    "invitation",
    "roster_import",
    "audit_log",
  ];

  it("tenant-scoped tables return 0 rows", async () => {
    for (const table of strictTables) {
      const [row] = await app.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`);
      expect({ table, n: Number(row!.n) }).toEqual({ table, n: 0 });
    }
    // Shared tables expose only global rows.
    expect(await app.role.count()).toBe(6);
    expect(await app.role.count({ where: { tenantId: { not: null } } })).toBe(0);
  });

  it("still returns 0 rows on a pooled connection that previously had a tenant set", async () => {
    const single = appClient("connection_limit=1");
    try {
      const inTenant = await withTenant(TENANT_A, (tx) => tx.person.count(), { client: single });
      expect(inTenant).toBe(EXPECTED.persons);
      // Same physical connection; app.tenant_id is now '' rather than unset.
      expect(await single.person.count()).toBe(0);
    } finally {
      await single.$disconnect();
    }
  });

  it("rejects INSERT when no tenant is set", async () => {
    await expect(
      app.person.create({
        data: { tenantId: TENANT_A, givenName: "No", familyName: "Tenant", displayName: "No Tenant" },
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("pre-tenant lookups", () => {
  it("ssos_user_memberships resolves a demo login to its tenant and role", async () => {
    const account = await owner.userAccount.findUniqueOrThrow({ where: { email: "parent.tirane@demo.ssos.test" } });
    const rows = await app.$queryRaw<{ tenant_id: string; role_key: string }[]>`
      SELECT tenant_id, role_key FROM ssos_user_memberships(${account.id}::uuid)`;
    expect(rows).toEqual([{ tenant_id: TENANT_A, role_key: "parent" }]);

    const noRole = await owner.userAccount.findUniqueOrThrow({ where: { email: "join@demo.ssos.test" } });
    const none = await app.$queryRaw<unknown[]>`SELECT * FROM ssos_user_memberships(${noRole.id}::uuid)`;
    expect(none).toEqual([]);
  });
});
