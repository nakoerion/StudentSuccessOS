-- Attendance rate (slice 3b): a DERIVED, never hand-edited aggregate of attendance_event.
--
-- attendance_rate_mv  — the materialised data (one row per tenant x student x term).
--                       Owned by the migration role; the app role has NO privileges on it.
-- attendance_rate     — the app-facing relation: a security_barrier view over the MV that
--                       filters by the current tenant with the SAME predicate as the RLS
--                       template. It is emitted by the RLS generator (rls/generate.ts,
--                       TENANT_DERIVED_VIEWS) in the following *_rls migration, SELECT only.
--
-- Why a view in front of the MV: PostgreSQL cannot enable row-level security on a
-- materialised view ("This operation is not supported for materialized views"), so tenant
-- isolation is applied by the view instead of a policy.
--
-- Term attribution: each attendance_event.date is matched to the term of the SAME tenant
-- whose [starts_on, ends_on] contains it (inclusive). If terms overlap, the one that starts
-- latest wins (ties: lowest id) so every event counts exactly once. Events whose date falls
-- in NO term (holidays between terms, dates outside every year) are KEPT and attributed to
-- term_id NULL ("unassigned") rather than silently dropped.
--
-- Formula (the default): total = present + late + absent + excused;
--   present_rate = ROUND(100.0 * (present + late) / NULLIF(total, 0), 2)
-- "late" counts as attended; "excused" stays in the denominator (counts as not attended).

CREATE MATERIALIZED VIEW "attendance_rate_mv" AS
WITH ev AS (
  SELECT ae.tenant_id, ae.student_person_id, t.term_id, ae.status
  FROM "attendance_event" ae
  LEFT JOIN LATERAL (
    SELECT tm.id AS term_id
    FROM "term" tm
    WHERE tm.tenant_id = ae.tenant_id
      AND ae.date BETWEEN tm.starts_on AND tm.ends_on
    ORDER BY tm.starts_on DESC, tm.id
    LIMIT 1
  ) t ON true
),
counts AS (
  SELECT tenant_id, student_person_id, term_id,
         count(*) FILTER (WHERE status = 'present')::int AS present,
         count(*) FILTER (WHERE status = 'late')::int    AS late,
         count(*) FILTER (WHERE status = 'absent')::int  AS absent,
         count(*) FILTER (WHERE status = 'excused')::int AS excused,
         count(*)::int                                   AS total
  FROM ev
  GROUP BY tenant_id, student_person_id, term_id
)
SELECT tenant_id, student_person_id, term_id, present, late, absent, excused, total,
       ROUND(100.0 * (present + late) / NULLIF(total, 0), 2)::numeric(5,2) AS present_rate
FROM counts
WITH DATA;

CREATE INDEX "attendance_rate_mv_tenant_student_idx" ON "attendance_rate_mv" (tenant_id, student_person_id);
CREATE INDEX "attendance_rate_mv_tenant_term_idx" ON "attendance_rate_mv" (tenant_id, term_id);

-- Owner-only refresh. SECURITY INVOKER: only the MV owner may REFRESH it anyway, and
-- EXECUTE is revoked from PUBLIC (the RLS generator never grants it to the app role).
CREATE OR REPLACE FUNCTION refresh_attendance_rate() RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$ REFRESH MATERIALIZED VIEW "attendance_rate_mv" $$;

REVOKE ALL ON FUNCTION refresh_attendance_rate() FROM PUBLIC;
