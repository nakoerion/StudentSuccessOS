-- ssos_user_memberships is SECURITY DEFINER and executable by the app role.
-- Previously it answered for ANY user id passed in, so code running as the
-- app role could enumerate other users' tenants and roles. It now answers only
-- for the caller: the transaction-local setting app.user_id (set by the
-- server from the verified session) must equal the requested id, otherwise
-- the function returns no rows. Signature is unchanged, so grants and
-- callers stay as they are.
CREATE OR REPLACE FUNCTION ssos_user_memberships(p_user_account_id uuid)
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
    AND p_user_account_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ORDER BY t.name, r.key;
$$;
REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM PUBLIC;
