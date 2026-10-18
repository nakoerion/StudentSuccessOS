-- Hand-written integrity rules Prisma's schema language cannot express.

-- System rows have tenant_id NULL; plain UNIQUE treats NULLs as distinct, so
-- make (tenant_id, key) unique with NULLS NOT DISTINCT (Postgres 15+).
ALTER TABLE "role" DROP CONSTRAINT IF EXISTS "role_tenant_id_key_key";
DROP INDEX IF EXISTS "role_tenant_id_key_key";
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role" ("tenant_id", "key") NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "grade_scale_country_pack_id_tenant_id_key_key";
CREATE UNIQUE INDEX "grade_scale_country_pack_id_tenant_id_key_key"
  ON "grade_scale" ("country_pack_id", "tenant_id", "key") NULLS NOT DISTINCT;

-- A role referenced from a tenant-owned row must be a system role or belong to
-- the same tenant. FKs cannot express this, so a trigger does. The lookup runs
-- as the calling role, so under RLS another tenant's role is simply not found.
--   TG_ARGV[0] = 'global_or_same' (role_assignment, invitation)
--              | 'exact'          (role_permission: tenant_id must equal role.tenant_id)
CREATE OR REPLACE FUNCTION ssos_check_role_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_tenant uuid;
BEGIN
  SELECT r.tenant_id INTO role_tenant FROM "role" r WHERE r.id = NEW.role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role % not visible to tenant %', NEW.role_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_ARGV[0] = 'exact' THEN
    IF role_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'role_permission.tenant_id must match role.tenant_id'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF role_tenant IS NOT NULL AND role_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'role % belongs to another tenant', NEW.role_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_assignment_role_tenant
  BEFORE INSERT OR UPDATE OF role_id, tenant_id ON "role_assignment"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_role_tenant('global_or_same');

CREATE TRIGGER invitation_role_tenant
  BEFORE INSERT OR UPDATE OF role_id, tenant_id ON "invitation"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_role_tenant('global_or_same');

CREATE TRIGGER role_permission_role_tenant
  BEFORE INSERT OR UPDATE OF role_id, tenant_id ON "role_permission"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_role_tenant('exact');

-- Pre-tenant lookups for Slice 2 (sign-in -> which schools/roles do I have?).
-- SECURITY DEFINER runs as the owner (BYPASSRLS) but only ever returns rows
-- linked to the given user account.
CREATE OR REPLACE FUNCTION ssos_user_memberships(p_user_account_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, person_id uuid, role_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.slug, t.name, p.id, r.key
  FROM person p
  JOIN tenant t ON t.id = p.tenant_id
  LEFT JOIN role_assignment ra ON ra.tenant_id = p.tenant_id AND ra.person_id = p.id
  LEFT JOIN "role" r ON r.id = ra.role_id
  WHERE p.user_account_id = p_user_account_id
  ORDER BY t.name, r.key;
$$;
REVOKE ALL ON FUNCTION ssos_user_memberships(uuid) FROM PUBLIC;
