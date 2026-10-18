/**
 * @ssos/auth — the app's whole view of authentication.
 *
 *   getSessionUser()          -> SessionUser | null   (server components / actions)
 *   signInWithPassword(...)   -> redirects on success, returns an error otherwise
 *   signOutUser(redirectTo)   -> clears the session and redirects
 *   authHandlers              -> mount at app/api/auth/[...nextauth]/route.ts
 *
 * Implementation today: Auth.js v5 Credentials + bcrypt hashes on user_account.
 */
import { AuthError } from "next-auth";

import { nextAuth } from "./next-auth";
import type { SessionUser, SignInResult } from "./types";

export type { SessionUser, SignInResult } from "./types";
export { verifyCredentials } from "./credentials";

export const authHandlers = nextAuth.handlers;

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await nextAuth.auth();
  const u = session?.user;
  if (!u?.id || !u.email) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    locale: (u as { locale?: string | null }).locale ?? null,
  };
}

/**
 * Call from a server action. On success this throws Next's redirect (so it
 * never returns); on bad credentials it returns { ok: false }.
 */
export async function signInWithPassword(email: string, password: string, redirectTo: string): Promise<SignInResult> {
  try {
    await nextAuth.signIn("credentials", { email, password, redirectTo });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: "invalid_credentials" };
    throw err;
  }
}

export async function signOutUser(redirectTo: string): Promise<void> {
  await nextAuth.signOut({ redirectTo });
}
