-- Slice 2: credentials auth, pending role claims, and SECURITY DEFINER lookups
-- that replace the runtime role's broad SELECT on tenant / user_account
-- (the grants themselves are tightened in the generated 20261019000100_rls).

-- Password hash (bcrypt) for the Credentials provider. NULL = cannot sign in
-- with a password (e.g. a future external-provider-only account).
ALTER TABLE "user_account" ADD COLUMN "password_hash" TEXT;

-- A role claimed through a join code waits for approval; invitations and
-- school-created assignments are active immediately.
ALTER TABLE "role_assignment" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_status_check"
  CHECK ("status" IN ('active', 'pending'));

-- Memberships now carry the tenant's default locale and the assignment status.
DROP FUNCTION IF EXISTS ssos_user_memberships(uuid);
CREATE FUNCTION ssos_user_memberships(p_user_account_id uuid)
RETURNS TABLE (
  tenant_id uuid, tenant_slug text, tenant_name text, default_locale text,
  person_id uuid, role_key text, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name, t.default_locale::text, p.id, r.key, ra.status
  FROM person p
  JOIN tenant t ON t.id = p.tenant_id
  LEFT JOIN role_assignment ra ON ra.tenant_id = p.tenant_id AND ra.person_id = p.id
  LEFT JOIN "role" r ON r.id = ra.role_id
  WHERE p.user_account_id = p_user_account_id
  ORDER BY t.name, r.key;
$$;
REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM PUBLIC;

-- Sign-in: exactly one account by e-mail (case-insensitive). The app role can
-- no longer SELECT user_account, so it cannot list accounts.
CREATE FUNCTION ssos_account_for_sign_in(p_email text)
RETURNS TABLE (id uuid, email text, display_name text, locale text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.display_name, u.locale::text, u.password_hash
  FROM user_account u
  WHERE lower(u.email) = lower(btrim(p_email))
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ssos_account_for_sign_in(text) FROM PUBLIC;

CREATE FUNCTION ssos_record_sign_in(p_user_account_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE user_account SET last_sign_in_at = now() WHERE id = p_user_account_id;
$$;
REVOKE ALL ON FUNCTION ssos_record_sign_in(uuid) FROM PUBLIC;

-- Join your school: resolve a typed join code to exactly one tenant.
CREATE FUNCTION ssos_tenant_by_join_code(p_code text)
RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name FROM tenant t
  WHERE upper(t.join_code) = upper(btrim(p_code))
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ssos_tenant_by_join_code(text) FROM PUBLIC;

-- Join your school: resolve an invitation code (invitation is tenant-scoped,
-- so before a tenant is chosen only this function can see it).
CREATE FUNCTION ssos_invitation_by_code(p_code text)
RETURNS TABLE (
  invitation_id uuid, tenant_id uuid, tenant_slug text, tenant_name text,
  role_key text, tenant_unit_id uuid, expires_at timestamptz,
  accepted_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, t.id, t.slug, t.name, r.key, i.tenant_unit_id, i.expires_at, i.accepted_at, i.revoked_at
  FROM invitation i
  JOIN tenant t ON t.id = i.tenant_id
  JOIN "role" r ON r.id = i.role_id
  WHERE upper(i.code) = upper(btrim(p_code))
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ssos_invitation_by_code(text) FROM PUBLIC;
