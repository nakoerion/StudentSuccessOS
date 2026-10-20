/**
 * @ssos/auth — the only auth surface pages use:
 *   getSessionUser()          -> SessionUser | null (server components / actions)
 *   signInWithPassword(...)   -> { ok } (server action; redirects on success)
 *   signOutUser(redirectTo)   -> clears the session and redirects
 *   authHandlers              -> mount at app/api/auth/[...auth]/route.ts
 * Edge middleware helpers live in "@ssos/auth/middleware".
 *
 * Implementation: Supabase Auth (cookie sessions via @supabase/ssr). Supabase
 * stores the password; the Supabase user id maps to user_account.external_auth_id.
 */
import { recordSignIn } from "@ssos/db";
import { redirect } from "next/navigation";
import { cache } from "react";

import { normaliseCredentials, sessionUserFromSubject } from "./credentials";
import { createSupabaseServerClient } from "./supabase";
import type { SessionUser, SignInResult } from "./types";

export type { SessionUser, SignInResult } from "./types";
export { normaliseCredentials, sessionUserFromSubject, type AuthSubject } from "./credentials";
export { authHandlers } from "./handlers";

/** Signed-in user for this request, or null. Memoised per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  // getClaims() verifies the access token's signature (JWKS) and refreshes an
  // expired session; never trust getSession() alone on the server.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims.sub) return null;
  const { sub, email, user_metadata } = data.claims;
  return sessionUserFromSubject({ sub, email, user_metadata });
});

/** Only allow same-origin relative redirects ("/x", not "//evil" or "https://"). */
export function safeRedirectPath(path: string | null | undefined, fallback = "/"): string {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : fallback;
}

/**
 * Call from a server action. On success this throws Next's redirect (so it
 * never returns); on bad credentials it returns { ok: false }.
 */
export async function signInWithPassword(email: string, password: string, redirectTo: string): Promise<SignInResult> {
  const input = normaliseCredentials(email, password);
  if (!input) return { ok: false, error: "invalid_credentials" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(input);
  if (error || !data.user) return { ok: false, error: "invalid_credentials" };

  const user = await sessionUserFromSubject({
    sub: data.user.id,
    email: data.user.email,
    user_metadata: data.user.user_metadata,
  });
  if (!user) {
    // Supabase knows the user but no account is (or can be) linked: don't keep a half session.
    await supabase.auth.signOut();
    return { ok: false, error: "invalid_credentials" };
  }
  await recordSignIn(user.id);
  redirect(safeRedirectPath(redirectTo));
}

export async function signOutUser(redirectTo: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(safeRedirectPath(redirectTo, "/sign-in"));
}
