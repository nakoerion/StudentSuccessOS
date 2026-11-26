-- Join-claim approval: a claim made with a join code (role_assignment.status = 'pending')
-- is now decided by a school admin. Approval turns it 'active'; rejection marks it
-- 'rejected' (no membership) with an optional short reason the claimant sees on /join.
-- No new table: role_assignment is already a tenant table under the shared RLS template,
-- so its policy and grants are unchanged.
ALTER TABLE "role_assignment" DROP CONSTRAINT IF EXISTS "role_assignment_status_check";
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_status_check"
  CHECK ("status" IN ('active', 'pending', 'rejected'));

-- When the person (re-)claimed the role; a rejected claim made again starts a new wait.
ALTER TABLE "role_assignment" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMPTZ(6);
ALTER TABLE "role_assignment" ADD COLUMN IF NOT EXISTS "decided_at" TIMESTAMPTZ(6);
ALTER TABLE "role_assignment" ADD COLUMN IF NOT EXISTS "decision_reason" TEXT;
ALTER TABLE "role_assignment" DROP CONSTRAINT IF EXISTS "role_assignment_decision_reason_len";
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_decision_reason_len"
  CHECK ("decision_reason" IS NULL OR char_length("decision_reason") <= 280);

UPDATE "role_assignment" SET "claimed_at" = "created_at" WHERE "status" = 'pending' AND "claimed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "role_assignment_tenant_id_status_idx" ON "role_assignment" ("tenant_id", "status");

-- The approver needs to see who is asking (their e-mail), but the app role cannot read
-- user_account. This answers only for the tenant in the transaction-local app.tenant_id
-- (set by withTenant) and only for people with a claim waiting there — never a list of
-- accounts. EXECUTE is granted to the app role by the generated RLS migration.
CREATE OR REPLACE FUNCTION ssos_pending_claimant_emails()
RETURNS TABLE (person_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT p.id, u.email
  FROM person p
  JOIN user_account u ON u.id = p.user_account_id
  JOIN role_assignment ra ON ra.tenant_id = p.tenant_id AND ra.person_id = p.id AND ra.status = 'pending'
  WHERE p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION ssos_pending_claimant_emails() FROM PUBLIC;
