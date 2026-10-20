/** What pages know about the signed-in user. Provider-agnostic on purpose. */
export interface SessionUser {
  /**
   * user_account.id (UUID) — the app's identity: passed to userMemberships(),
   * withTenant({ userId }) (app.user_id) and person.user_account_id.
   */
  id: string;
  /** Auth-provider subject: Supabase auth.users.id (= user_account.external_auth_id). */
  authId: string;
  email: string;
  name: string | null;
  /** Preferred UI locale stored on the account, if any. */
  locale: string | null;
}

export type SignInResult = { ok: true } | { ok: false; error: "invalid_credentials" };
