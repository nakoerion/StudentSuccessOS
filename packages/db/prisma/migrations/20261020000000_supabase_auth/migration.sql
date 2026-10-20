-- Slice 2b: Supabase Auth replaces the NextAuth Credentials provider.
-- Supabase stores and verifies passwords; our user_account row is linked to
-- the Supabase auth.users.id through user_account.external_auth_id.

-- Passwords no longer live here.
DROP FUNCTION IF EXISTS ssos_account_for_sign_in(text);
ALTER TABLE "user_account" DROP COLUMN IF EXISTS "password_hash";

-- Resolve the verified Supabase subject to exactly one user_account.
-- If no account is linked yet, provision one for that subject (an account with
-- no roles lands on "Join your school"). An existing account with the same
-- e-mail is NEVER auto-linked here: linking is an explicit admin step
-- (packages/db/scripts/seed-supabase-auth.ts), so a provider-side e-mail can't
-- take over an existing account. In that collision case nothing is returned.
CREATE FUNCTION ssos_account_for_auth(p_external_auth_id text, p_email text, p_display_name text)
RETURNS TABLE (id uuid, email text, display_name text, locale text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_external_auth_id IS NULL OR btrim(p_external_auth_id) = '' THEN
    RETURN;
  END IF;

  INSERT INTO user_account (email, external_auth_id, display_name)
  SELECT lower(btrim(p_email)), p_external_auth_id, NULLIF(btrim(p_display_name), '')
  WHERE p_email IS NOT NULL AND btrim(p_email) <> ''
    AND NOT EXISTS (SELECT 1 FROM user_account u WHERE u.external_auth_id = p_external_auth_id)
  ON CONFLICT DO NOTHING;

  RETURN QUERY
    SELECT u.id, u.email, u.display_name, u.locale::text
    FROM user_account u
    WHERE u.external_auth_id = p_external_auth_id
    LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION ssos_account_for_auth(text, text, text) FROM PUBLIC;
