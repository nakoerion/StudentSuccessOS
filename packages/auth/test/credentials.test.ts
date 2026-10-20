import { createAdminClient, prisma } from "@ssos/db";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { normaliseCredentials, sessionUserFromSubject } from "../src/credentials";

const owner = createAdminClient();

afterAll(async () => {
  await prisma.$disconnect();
  await owner.$disconnect();
});

describe("normaliseCredentials", () => {
  it("trims and lower-cases the e-mail, keeps the password as typed", () => {
    expect(normaliseCredentials("  Admin.Tirane@demo.ssos.test ", "Demo1234!")).toEqual({
      email: "admin.tirane@demo.ssos.test",
      password: "Demo1234!",
    });
  });

  it("rejects malformed input before anything reaches Supabase", () => {
    expect(normaliseCredentials("not-an-email", "Demo1234!")).toBeNull();
    expect(normaliseCredentials("a@b.test", "")).toBeNull();
    expect(normaliseCredentials("a@b.test", "x".repeat(201))).toBeNull();
    expect(normaliseCredentials(undefined, undefined)).toBeNull();
  });
});

describe("sessionUserFromSubject (mocked account lookup)", () => {
  it("maps the Supabase subject to user_account via external_auth_id", async () => {
    const lookup = vi.fn().mockResolvedValue({ id: "acc-1", email: "a@b.test", displayName: "A B", locale: "sq" });
    const user = await sessionUserFromSubject(
      { sub: "sb-uuid", email: "a@b.test", user_metadata: { display_name: "A B" } },
      lookup,
    );
    expect(lookup).toHaveBeenCalledWith({ externalAuthId: "sb-uuid", email: "a@b.test", displayName: "A B" });
    expect(user).toEqual({ id: "acc-1", authId: "sb-uuid", email: "a@b.test", name: "A B", locale: "sq" });
  });

  it("returns null without a subject/e-mail or when no account can be linked", async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    expect(await sessionUserFromSubject({ sub: "sb-uuid", email: "a@b.test" }, lookup)).toBeNull();
    expect(await sessionUserFromSubject({ sub: "", email: "a@b.test" }, lookup)).toBeNull();
    expect(await sessionUserFromSubject({ sub: "sb-uuid", email: null }, lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

/**
 * Live check against the real Supabase project + local DB. Needs SUPABASE_URL,
 * SUPABASE_PUBLISHABLE_KEY and `pnpm auth:seed` (skipped when not configured).
 */
const live = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);

describe.skipIf(!live)("Supabase Auth (live project, seeded demo logins)", () => {
  const supabase = () =>
    createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  it("demo password signs in and the Supabase id resolves to the seeded account", async () => {
    const { data, error } = await supabase().auth.signInWithPassword({
      email: "admin.tirane@demo.ssos.test",
      password: "Demo1234!",
    });
    expect(error).toBeNull();
    const account = await owner.userAccount.findUniqueOrThrow({ where: { email: "admin.tirane@demo.ssos.test" } });
    expect(account.externalAuthId).toBe(data.user!.id);

    // Real lookup through the app role's SECURITY DEFINER function.
    const user = await sessionUserFromSubject({ sub: data.user!.id, email: data.user!.email });
    expect(user).toEqual({
      id: account.id,
      authId: data.user!.id,
      email: "admin.tirane@demo.ssos.test",
      name: account.displayName,
      locale: "sq",
    });
  });

  it("rejects a wrong password and an unknown e-mail", async () => {
    const wrong = await supabase().auth.signInWithPassword({ email: "admin.tirane@demo.ssos.test", password: "nope" });
    expect(wrong.error?.code).toBe("invalid_credentials");
    const unknown = await supabase().auth.signInWithPassword({ email: "nobody@demo.ssos.test", password: "Demo1234!" });
    expect(unknown.error?.code).toBe("invalid_credentials");
  });
});
