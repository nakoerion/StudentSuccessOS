/** What pages know about the signed-in user. Provider-agnostic on purpose. */
export interface SessionUser {
  /** user_account.id (UUID). */
  id: string;
  email: string;
  name: string | null;
  /** Preferred UI locale stored on the account, if any. */
  locale: string | null;
}

export type SignInResult = { ok: true } | { ok: false; error: "invalid_credentials" };
