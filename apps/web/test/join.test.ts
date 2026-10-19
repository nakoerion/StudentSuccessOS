/**
 * Join code -> pending claim; invitation code -> active role (single use).
 * Runs as the app role, then restores the seed state with the owner client.
 */
import { createAdminClient, prisma, userMemberships } from "@ssos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptInvitationCode, claimRoleWithJoinCode, lookupCode } from "../lib/join";
import { resolveLanding } from "../lib/tenancy";

const owner = createAdminClient();
let joiner: { userId: string; name: string; email: string };

async function cleanup() {
  await owner.invitation.updateMany({
    where: { code: { in: ["INV-TIR-001", "INV-AUH-001"] } },
    data: { acceptedAt: null, personId: null },
  });
  await owner.person.deleteMany({ where: { userAccountId: joiner.userId } });
}

beforeAll(async () => {
  const account = await owner.userAccount.findUniqueOrThrow({ where: { email: "join@demo.ssos.test" } });
  joiner = { userId: account.id, name: "New User", email: account.email };
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
  await prisma.$disconnect();
});

describe("lookupCode", () => {
  it("recognises join codes and invitation codes, case/space-insensitive", async () => {
    expect(await lookupCode(" tir-4821 ")).toMatchObject({ kind: "join", slug: "liceu-demo-tirane" });
    expect(await lookupCode("AUH-7315")).toMatchObject({ kind: "join", slug: "demo-school-abu-dhabi" });
    expect(await lookupCode("inv-auh-001")).toMatchObject({ kind: "invitation", roleKey: "teacher" });
    expect(await lookupCode("XYZ-0000")).toEqual({ kind: "invalid" });
    expect(await lookupCode("")).toEqual({ kind: "invalid" });
  });

  it("treats an expired invitation as used", async () => {
    expect(await lookupCode("INV-AUH-001", new Date("2030-01-01"))).toEqual({ kind: "used" });
  });
});

describe("claimRoleWithJoinCode", () => {
  it("rejects roles that are not claimable (admin, advisor) and bad codes", async () => {
    expect(await claimRoleWithJoinCode(joiner, "TIR-4821", "admin")).toEqual({ ok: false, error: "invalid_role" });
    expect(await claimRoleWithJoinCode(joiner, "NOPE", "student")).toEqual({ ok: false, error: "invalid_code" });
    // An invitation code is not a join code.
    expect(await claimRoleWithJoinCode(joiner, "INV-TIR-001", "student")).toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  it("creates a PENDING assignment -> landing is 'waiting for approval'", async () => {
    expect(await claimRoleWithJoinCode(joiner, "TIR-4821", "parent")).toEqual({
      ok: true,
      slug: "liceu-demo-tirane",
      status: "pending",
    });
    // Idempotent: claiming again does not duplicate.
    await claimRoleWithJoinCode(joiner, "TIR-4821", "parent");
    const rows = await userMemberships(joiner.userId);
    expect(rows).toEqual([expect.objectContaining({ tenantSlug: "liceu-demo-tirane", roleKey: "parent", status: "pending" })]);
    expect(resolveLanding(rows).kind).toBe("pending");
  });
});

describe("acceptInvitationCode", () => {
  it("grants the invitation's role immediately and only once", async () => {
    expect(await acceptInvitationCode(joiner, "INV-AUH-001")).toEqual({
      ok: true,
      slug: "demo-school-abu-dhabi",
      status: "active",
    });
    const landing = resolveLanding(await userMemberships(joiner.userId));
    expect(landing).toEqual({ kind: "tenant", slug: "demo-school-abu-dhabi" });
    expect(await acceptInvitationCode(joiner, "INV-AUH-001")).toEqual({ ok: false, error: "code_used" });
    expect(await acceptInvitationCode(joiner, "TIR-4821")).toEqual({ ok: false, error: "invalid_code" });
  });
});
