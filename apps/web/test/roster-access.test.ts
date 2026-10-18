/**
 * Parent-only-sees-own-children, enforced in the query (server side), against
 * the seeded database as the RLS-enforced app role.
 */
import { createAdminClient, prisma, userMemberships, withTenant } from "@ssos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadViewer, rosterScope } from "../lib/access";
import { dashboardCounts, listRoster, rosterWhere } from "../lib/roster";
import { membershipForSlug } from "../lib/tenancy";

const owner = createAdminClient();
const TIRANA = "liceu-demo-tirane";

async function viewerFor(email: string) {
  const account = await owner.userAccount.findUniqueOrThrow({ where: { email } });
  const m = membershipForSlug(await userMemberships(account.id), TIRANA);
  if (!m) throw new Error(`${email} has no active membership in ${TIRANA}`);
  return { m, userId: account.id };
}

let parentChildIds: string[] = [];

beforeAll(async () => {
  const parent = await owner.person.findFirstOrThrow({
    where: { userAccount: { email: "parent.tirane@demo.ssos.test" } },
    include: { guardianOf: true },
  });
  parentChildIds = parent.guardianOf.map((g) => g.studentPersonId).sort();
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.$disconnect();
});

describe("roster scope from permissions", () => {
  it("admin / teacher read the whole roster; a parent only own children", async () => {
    for (const [email, kind] of [
      ["admin.tirane@demo.ssos.test", "all"],
      ["teacher.tirane@demo.ssos.test", "all"],
      ["parent.tirane@demo.ssos.test", "own_children"],
    ] as const) {
      const { m, userId } = await viewerFor(email);
      const viewer = await withTenant(m.tenantId, (tx) => loadViewer(tx, m.personId), { userId });
      expect({ email, kind: rosterScope(viewer).kind }).toEqual({ email, kind });
    }
  });

  it("a viewer with no permissions gets nothing (no WHERE at all)", () => {
    expect(rosterScope({ personId: "x", roles: ["student"], permissions: new Set(["consent.manage_own"]) })).toEqual({
      kind: "none",
    });
    expect(rosterWhere({ kind: "none" }, { filter: "all" })).toBeNull();
  });
});

describe("listRoster", () => {
  it("admin sees 30 students, 6 teachers, 20 parents; students carry their guardians", async () => {
    const { m, userId } = await viewerFor("admin.tirane@demo.ssos.test");
    const result = await withTenant(
      m.tenantId,
      async (tx) => {
        const scope = rosterScope(await loadViewer(tx, m.personId));
        return {
          all: await listRoster(tx, scope, { filter: "all" }),
          students: await listRoster(tx, scope, { filter: "student" }),
          teachers: await listRoster(tx, scope, { filter: "teacher" }),
          parents: await listRoster(tx, scope, { filter: "parent" }),
          counts: await dashboardCounts(tx),
        };
      },
      { userId },
    );
    expect(result.students).toHaveLength(30);
    expect(result.teachers).toHaveLength(6);
    expect(result.parents).toHaveLength(20);
    expect(result.all).toHaveLength(56);
    expect(result.counts).toEqual({ students: 30, teachers: 6, parents: 20, classes: 3 });
    expect(result.students.every((s) => s.guardians.length >= 1)).toBe(true);
  });

  it("name search is server-side and case-insensitive", async () => {
    const { m, userId } = await viewerFor("admin.tirane@demo.ssos.test");
    const target = await owner.person.findFirstOrThrow({ where: { tenantId: m.tenantId, externalRef: "S-001" } });
    const rows = await withTenant(
      m.tenantId,
      async (tx) =>
        listRoster(tx, rosterScope(await loadViewer(tx, m.personId)), {
          filter: "all",
          search: target.givenName.toUpperCase(),
        }),
      { userId },
    );
    expect(rows.map((r) => r.id)).toContain(target.id);
    expect(rows.every((r) => r.displayName.toLowerCase().includes(target.givenName.toLowerCase()))).toBe(true);
  });

  it("a parent receives ONLY their own children — whatever filter or search they send", async () => {
    const { m, userId } = await viewerFor("parent.tirane@demo.ssos.test");
    expect(parentChildIds).toHaveLength(2);
    const results = await withTenant(
      m.tenantId,
      async (tx) => {
        const scope = rosterScope(await loadViewer(tx, m.personId));
        const out = [];
        for (const filter of ["all", "student", "teacher", "parent"] as const) {
          out.push(await listRoster(tx, scope, { filter }));
        }
        return out;
      },
      { userId },
    );
    const [all, students, teachers, parents] = results;
    expect(all!.map((r) => r.id).sort()).toEqual(parentChildIds);
    expect(students!.map((r) => r.id).sort()).toEqual(parentChildIds);
    // Filters cannot widen the scope: teachers/parents tabs still return only the children.
    expect(teachers!.map((r) => r.id).sort()).toEqual(parentChildIds);
    expect(parents!.map((r) => r.id).sort()).toEqual(parentChildIds);
    expect(all!.every((r) => r.roles.includes("student"))).toBe(true);
    expect(all!.every((r) => r.children.length === 0)).toBe(true);
  });

  it("a parent searching for another family's child gets nothing", async () => {
    const { m, userId } = await viewerFor("parent.tirane@demo.ssos.test");
    const other = await owner.person.findFirstOrThrow({
      where: { tenantId: m.tenantId, externalRef: "S-030" },
    });
    expect(parentChildIds).not.toContain(other.id);
    const rows = await withTenant(
      m.tenantId,
      async (tx) =>
        listRoster(tx, rosterScope(await loadViewer(tx, m.personId)), { filter: "all", search: other.displayName }),
      { userId },
    );
    expect(rows.map((r) => r.id)).not.toContain(other.id);
  });
});
