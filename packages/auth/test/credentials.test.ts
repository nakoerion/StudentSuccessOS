import { prisma } from "@ssos/db";
import { afterAll, describe, expect, it } from "vitest";

import { verifyCredentials } from "../src/credentials";
import { hashPassword, verifyPassword } from "../src/password";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("password hashing", () => {
  it("round-trips and rejects a wrong password or a missing hash", async () => {
    const hash = await hashPassword("s3cret!");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("s3cret!", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("s3cret!", null)).toBe(false);
  });
});

describe("verifyCredentials (seeded demo accounts, app role)", () => {
  it("accepts the demo password, case-insensitive e-mail", async () => {
    const user = await verifyCredentials("  Admin.Tirane@demo.ssos.test ", "Demo1234!");
    expect(user).toMatchObject({ email: "admin.tirane@demo.ssos.test", locale: "sq" });
    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a wrong password, an unknown e-mail and malformed input alike", async () => {
    expect(await verifyCredentials("admin.tirane@demo.ssos.test", "nope")).toBeNull();
    expect(await verifyCredentials("nobody@demo.ssos.test", "Demo1234!")).toBeNull();
    expect(await verifyCredentials("not-an-email", "Demo1234!")).toBeNull();
    expect(await verifyCredentials(undefined, undefined)).toBeNull();
  });
});
