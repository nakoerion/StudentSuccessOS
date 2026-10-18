import { accountForSignIn, recordSignIn } from "@ssos/db";

import { verifyPassword } from "./password";
import type { SessionUser } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Provider-independent credential check. Reads the account through the
 * SECURITY DEFINER lookup (the app role cannot SELECT user_account).
 * Returns null for any failure — never says whether the e-mail exists.
 */
export async function verifyCredentials(email: unknown, password: unknown): Promise<SessionUser | null> {
  if (typeof email !== "string" || typeof password !== "string") return null;
  const normalised = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalised) || password.length === 0 || password.length > 200) return null;

  const account = await accountForSignIn(normalised);
  const ok = await verifyPassword(password, account?.passwordHash);
  if (!account || !ok) return null;

  await recordSignIn(account.id);
  return { id: account.id, email: account.email, name: account.displayName, locale: account.locale };
}
