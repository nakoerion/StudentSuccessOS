/**
 * The Next-facing surface with Supabase, next/headers, next/navigation and the
 * DB lookup mocked: what gets called, what cookies move, where we redirect.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  getClaims: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  exchangeCodeForSession: vi.fn(),
};
type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (c: { name: string; value: string; options: object }[]) => void;
};
let lastCookies: CookieMethods | undefined;

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, opts: { cookies: CookieMethods }) => {
    lastCookies = opts.cookies;
    return { auth };
  }),
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

const db = { accountForAuthSubject: vi.fn(), recordSignIn: vi.fn() };
vi.mock("@ssos/db", () => db);

const ACCOUNT = { id: "acc-1", email: "admin.tirane@demo.ssos.test", displayName: "Admin", locale: "sq" };

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  db.accountForAuthSubject.mockResolvedValue(ACCOUNT);
});

describe("signInWithPassword", () => {
  it("signs in with Supabase, sets the session cookie, records the sign-in and redirects", async () => {
    const { signInWithPassword } = await import("../src/index");
    auth.signInWithPassword.mockImplementation(async () => {
      lastCookies!.setAll([{ name: "sb-test-auth-token", value: "tok", options: {} }]);
      return { data: { user: { id: "sb-1", email: ACCOUNT.email, user_metadata: {} } }, error: null };
    });
    await expect(signInWithPassword(" Admin.Tirane@demo.ssos.test ", "Demo1234!", "/")).rejects.toMatchObject({
      to: "/",
    });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: ACCOUNT.email, password: "Demo1234!" });
    expect(jar.get("sb-test-auth-token")).toBe("tok");
    expect(db.accountForAuthSubject).toHaveBeenCalledWith(expect.objectContaining({ externalAuthId: "sb-1" }));
    expect(db.recordSignIn).toHaveBeenCalledWith("acc-1");
  });

  it("returns { ok: false } for bad credentials or malformed input", async () => {
    const { signInWithPassword } = await import("../src/index");
    auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { code: "invalid_credentials" } });
    expect(await signInWithPassword("a@b.test", "nope", "/")).toEqual({ ok: false, error: "invalid_credentials" });
    expect(await signInWithPassword("not-an-email", "x", "/")).toEqual({ ok: false, error: "invalid_credentials" });
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(db.recordSignIn).not.toHaveBeenCalled();
  });

  it("signs back out when the Supabase user cannot be linked to an account", async () => {
    const { signInWithPassword } = await import("../src/index");
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: "sb-x", email: "x@b.test" } }, error: null });
    db.accountForAuthSubject.mockResolvedValue(null);
    expect(await signInWithPassword("x@b.test", "pw", "/")).toEqual({ ok: false, error: "invalid_credentials" });
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("never redirects off-site", async () => {
    const { safeRedirectPath } = await import("../src/index");
    expect(safeRedirectPath("//evil.test")).toBe("/");
    expect(safeRedirectPath("https://evil.test")).toBe("/");
    expect(safeRedirectPath("/t/x")).toBe("/t/x");
  });
});

describe("getSessionUser / signOutUser", () => {
  it("reads verified claims and maps them to the account", async () => {
    const { getSessionUser } = await import("../src/index");
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: "sb-1", email: ACCOUNT.email } }, error: null });
    expect(await getSessionUser()).toEqual({
      id: "acc-1",
      authId: "sb-1",
      email: ACCOUNT.email,
      name: "Admin",
      locale: "sq",
    });
  });

  it("returns null without a valid session", async () => {
    const { getSessionUser } = await import("../src/index");
    auth.getClaims.mockResolvedValue({ data: null, error: { message: "no session" } });
    expect(await getSessionUser()).toBeNull();
    expect(db.accountForAuthSubject).not.toHaveBeenCalled();
  });

  it("signOutUser clears the Supabase session and redirects", async () => {
    const { signOutUser } = await import("../src/index");
    await expect(signOutUser("/sign-in")).rejects.toMatchObject({ to: "/sign-in" });
    expect(auth.signOut).toHaveBeenCalled();
  });
});

describe("middleware updateSession", () => {
  it("reports the subject and forwards refreshed cookies + extra headers", async () => {
    const { updateSession } = await import("../src/middleware");
    auth.getClaims.mockImplementation(async () => {
      lastCookies!.setAll([{ name: "sb-test-auth-token", value: "fresh", options: { path: "/" } }]);
      return { data: { claims: { sub: "sb-1" } }, error: null };
    });
    const req = new NextRequest("http://localhost/t/x", { headers: { cookie: "sb-test-auth-token=old" } });
    const headers = new Headers(req.headers);
    headers.set("x-ssos-pathname", "/t/x");
    const session = await updateSession(req, headers);
    expect(session.authSubject).toBe("sb-1");
    expect(session.response.cookies.get("sb-test-auth-token")?.value).toBe("fresh");
    expect(session.response.headers.get("x-middleware-request-x-ssos-pathname")).toBe("/t/x");
    expect(session.response.headers.get("x-middleware-request-cookie")).toContain("sb-test-auth-token=fresh");
  });

  it("no session -> null subject; redirect keeps cookies", async () => {
    const { updateSession, redirectWithSession } = await import("../src/middleware");
    auth.getClaims.mockImplementation(async () => {
      lastCookies!.setAll([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0 } }]);
      return { data: null, error: { message: "expired" } };
    });
    const req = new NextRequest("http://localhost/t/x");
    const session = await updateSession(req);
    expect(session.authSubject).toBeNull();
    const res = redirectWithSession(session, new URL("/sign-in", req.url));
    expect(res.headers.get("location")).toBe("http://localhost/sign-in");
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("");
  });
});

describe("authHandlers", () => {
  it("GET /api/auth/session -> 200 with the user, 401 without", async () => {
    const { authHandlers } = await import("../src/handlers");
    auth.getClaims.mockResolvedValueOnce({ data: { claims: { sub: "sb-1", email: ACCOUNT.email } }, error: null });
    const ok = await authHandlers.GET(new Request("http://localhost/api/auth/session"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ user: { id: "acc-1", authId: "sb-1" } });
    auth.getClaims.mockResolvedValueOnce({ data: null, error: { message: "none" } });
    expect((await authHandlers.GET(new Request("http://localhost/api/auth/session"))).status).toBe(401);
  });

  it("GET /api/auth/callback exchanges the code and redirects only on-site", async () => {
    const { authHandlers } = await import("../src/handlers");
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await authHandlers.GET(new Request("http://localhost/api/auth/callback?code=abc&next=//evil.test"));
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(res.headers.get("location")).toBe("http://localhost/");
  });

  it("POST /api/auth/sign-out signs out; unknown actions 404", async () => {
    const { authHandlers } = await import("../src/handlers");
    const res = await authHandlers.POST(new Request("http://localhost/api/auth/sign-out", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(auth.signOut).toHaveBeenCalled();
    expect((await authHandlers.POST(new Request("http://localhost/api/auth/nope", { method: "POST" }))).status).toBe(404);
  });
});
