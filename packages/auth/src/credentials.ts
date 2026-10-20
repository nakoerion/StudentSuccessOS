import { accountForAuthSubject, type AuthAccount } from "@ssos/db";

import type { SessionUser } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Provider-independent input check before anything is sent to Supabase.
 * Returns null for malformed input (callers answer "invalid credentials").
 */
export function normaliseCredentials(email: unknown, password: unknown): { email: string; password: string } | null {
  if (typeof email !== "string" || typeof password !== "string") return null;
  const normalised = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalised) || password.length === 0 || password.length > 200) return null;
  return { email: normalised, password };
}

/** The verified identity Supabase gives us (JWT claims or auth user). */
export interface AuthSubject {
  /** Supabase auth.users.id. */
  sub: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export type AccountLookup = (subject: {
  externalAuthId: string;
  email: string;
  displayName?: string | null;
}) => Promise<AuthAccount | null>;

/**
 * Map a VERIFIED Supabase subject to our SessionUser through
 * user_account.external_auth_id (see accountForAuthSubject in @ssos/db).
 */
export async function sessionUserFromSubject(
  subject: AuthSubject,
  lookup: AccountLookup = (s) => accountForAuthSubject(s),
): Promise<SessionUser | null> {
  if (!subject.sub || !subject.email) return null;
  const meta = subject.user_metadata ?? {};
  const displayName =
    typeof meta.display_name === "string" ? meta.display_name : typeof meta.full_name === "string" ? meta.full_name : null;
  const account = await lookup({ externalAuthId: subject.sub, email: subject.email, displayName });
  if (!account) return null;
  return { id: account.id, authId: subject.sub, email: account.email, name: account.displayName, locale: account.locale };
}
