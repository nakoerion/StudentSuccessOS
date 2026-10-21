-- ssos_user_memberships also returns the tenant's country-pack code, so the web
-- app can resolve the tenant's default locale from @ssos/country-packs (falling
-- back to the pack's primary language when tenant.default_locale is not one the
-- pack supports). The caller-only guard (app.user_id must equal the requested
-- id) is unchanged. Adding an OUT column changes the return type, so the
-- function is dropped and re-created, and its grants restated: no PUBLIC
-- execute, EXECUTE for the runtime role only. RLS policies are not touched.
DROP FUNCTION IF EXISTS ssos_user_memberships(uuid);

CREATE FUNCTION ssos_user_memberships(p_user_account_id uuid)
RETURNS TABLE (
  tenant_id uuid, tenant_slug text, tenant_name text, default_locale text,
  country_code text, person_id uuid, role_key text, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name, t.default_locale::text, cp.code::text, p.id, r.key, ra.status
  FROM person p
  JOIN tenant t ON t.id = p.tenant_id
  JOIN country_pack cp ON cp.id = t.country_pack_id
  LEFT JOIN role_assignment ra ON ra.tenant_id = p.tenant_id AND ra.person_id = p.id
  LEFT JOIN "role" r ON r.id = ra.role_id
  WHERE p.user_account_id = p_user_account_id
    AND p_user_account_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ORDER BY t.name, r.key;
$$;

REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM authenticated';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION ssos_user_memberships(uuid) TO ssos_app;
