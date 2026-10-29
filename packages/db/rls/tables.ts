/**
 * The single source of truth for which tables are tenant-scoped.
 *
 * - "tenant": tenant_id NOT NULL. Rows are visible/writable only when
 *   tenant_id = app.tenant_id.
 * - "shared": tenant_id NULLABLE. NULL rows are global (e.g. system roles) and
 *   readable by every tenant but writable by none (only the owner role, which
 *   bypasses RLS, writes them). Non-NULL rows behave exactly like "tenant".
 *
 * test/rls-coverage.test.ts introspects the Prisma DMMF and fails if any model
 * with a tenantId field is missing here (or listed here but not in the schema).
 */
export type TenantScope = "tenant" | "shared";

/**
 * What the app role may do with the rows tenant_isolation lets it see.
 * - "read_write" (default): SELECT, INSERT, UPDATE, DELETE.
 * - "append_only": SELECT, INSERT. UPDATE/DELETE are not granted, so they fail
 *   with "permission denied" (e.g. the `event` timeline).
 * - "derived": SELECT only. Rows are computed by a service running as the owner
 *   (or a SECURITY DEFINER function), never hand-edited (term/annual grades).
 */
export type TenantAccess = "read_write" | "append_only" | "derived";

export const ACCESS_PRIVILEGES: Record<TenantAccess, string> = {
  read_write: "SELECT, INSERT, UPDATE, DELETE",
  append_only: "SELECT, INSERT",
  derived: "SELECT",
};

export interface TenantScopedTable {
  /** Prisma model name. */
  model: string;
  /** Postgres table name (@@map). */
  table: string;
  scope: TenantScope;
  /** Defaults to "read_write". */
  access?: TenantAccess;
}

export const TENANT_SCOPED_TABLES: readonly TenantScopedTable[] = [
  { model: "GradeScale", table: "grade_scale", scope: "shared" },
  { model: "Role", table: "role", scope: "shared" },
  { model: "RolePermission", table: "role_permission", scope: "shared" },
  { model: "TenantUnit", table: "tenant_unit", scope: "tenant" },
  { model: "TenantSetting", table: "tenant_setting", scope: "tenant" },
  { model: "Person", table: "person", scope: "tenant" },
  { model: "RoleAssignment", table: "role_assignment", scope: "tenant" },
  { model: "Guardianship", table: "guardianship", scope: "tenant" },
  { model: "Consent", table: "consent", scope: "tenant" },
  { model: "Invitation", table: "invitation", scope: "tenant" },
  { model: "RosterImport", table: "roster_import", scope: "tenant" },
  { model: "AuditLog", table: "audit_log", scope: "tenant" },
  // Academic record.
  { model: "AcademicYear", table: "academic_year", scope: "tenant" },
  { model: "Term", table: "term", scope: "tenant" },
  { model: "Subject", table: "subject", scope: "tenant" },
  { model: "Course", table: "course", scope: "tenant" },
  { model: "ClassSection", table: "class_section", scope: "tenant" },
  { model: "Enrollment", table: "enrollment", scope: "tenant" },
  { model: "TeacherAssignment", table: "teacher_assignment", scope: "tenant" },
  { model: "TimetableSlot", table: "timetable_slot", scope: "tenant" },
  { model: "AttendanceEvent", table: "attendance_event", scope: "tenant" },
  { model: "AssessmentCategory", table: "assessment_category", scope: "tenant" },
  { model: "GradeEntry", table: "grade_entry", scope: "tenant" },
  { model: "TermGrade", table: "term_grade", scope: "tenant", access: "derived" },
  { model: "AnnualGrade", table: "annual_grade", scope: "tenant", access: "derived" },
  { model: "Assignment", table: "assignment", scope: "tenant" },
  { model: "Submission", table: "submission", scope: "tenant" },
  { model: "RubricScore", table: "rubric_score", scope: "tenant" },
  { model: "Note", table: "note", scope: "tenant" },
  { model: "Event", table: "event", scope: "tenant", access: "append_only" },
  { model: "Edge", table: "edge", scope: "tenant" },
  { model: "MasteryState", table: "mastery_state", scope: "tenant" },
];

/**
 * Global tables (no tenant_id). The runtime role gets only the privileges
 * listed here. Every global table has RLS enabled + forced with an explicit policy
 * (hosted Postgres such as Supabase auto-enables RLS on new tables, and RLS with no
 * policy silently reads as empty): `selfColumn` -> `tenant_self` row filter (tenant);
 * otherwise, if readable, `global_read` (SELECT every row); privileges null -> no policy.
 */
export interface GlobalTable {
  table: string;
  /** Privileges granted to the app role; null = none (access only via SECURITY DEFINER functions). */
  privileges: string | null;
  /**
   * Optional self-row filter: the app role sees only the row whose `column`
   * equals the current tenant (same expression as the tenant template).
   */
  selfColumn?: string;
}

export const GLOBAL_TABLES: readonly GlobalTable[] = [
  { table: "country_pack", privileges: "SELECT" },
  { table: "permission", privileges: "SELECT" },
  // Slice 2: the app sees only the current tenant's own row.
  { table: "tenant", privileges: "SELECT", selfColumn: "id" },
  // Slice 2: no direct access. Sign-in resolves the account via ssos_account_for_auth().
  { table: "user_account", privileges: null },
  // Academic record: curriculum codes per country pack, shared read-only.
  { table: "concept", privileges: "SELECT" },
  { table: "concept_edge", privileges: "SELECT" },
];

/**
 * Derived, tenant-scoped relations backed by a MATERIALIZED VIEW.
 *
 * PostgreSQL cannot enable row-level security on a materialised view, so the MV
 * (`source`) gets no app-role privileges at all and the app reads it through `view`:
 * a security_barrier view filtered with the SAME tenant predicate as the RLS template,
 * granted SELECT only (never hand-editable). Refreshing is owner-only.
 */
export interface TenantDerivedView {
  /** App-facing view name. */
  view: string;
  /** The materialised view behind it (created by its own migration). */
  source: string;
}

export const TENANT_DERIVED_VIEWS: readonly TenantDerivedView[] = [
  // Slice 3b: attendance rate per tenant x student x term (refresh_attendance_rate()).
  { view: "attendance_rate", source: "attendance_rate_mv" },
];

/**
 * SECURITY DEFINER functions the app role may call before a tenant is chosen.
 * Each returns rows for exactly one key (user id, e-mail, code) — never a list.
 */
export const APP_FUNCTIONS: readonly string[] = [
  "ssos_user_memberships(uuid)",
  "ssos_account_for_auth(text, text, text)",
  "ssos_record_sign_in(uuid)",
  "ssos_tenant_by_join_code(text)",
  "ssos_invitation_by_code(text)",
];

/** Non-superuser, NOBYPASSRLS role the application connects as. */
export const APP_ROLE = "ssos_app";
