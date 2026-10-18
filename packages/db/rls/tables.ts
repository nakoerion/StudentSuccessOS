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

export interface TenantScopedTable {
  /** Prisma model name. */
  model: string;
  /** Postgres table name (@@map). */
  table: string;
  scope: TenantScope;
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
];

/**
 * Global tables (no tenant_id). The runtime role gets only the privileges
 * listed here; RLS is not applied because the rows are not tenant-owned.
 */
export const GLOBAL_TABLES: readonly { table: string; privileges: string }[] = [
  { table: "country_pack", privileges: "SELECT" },
  { table: "permission", privileges: "SELECT" },
  { table: "tenant", privileges: "SELECT" },
  { table: "user_account", privileges: "SELECT, INSERT, UPDATE" },
];

/** Non-superuser, NOBYPASSRLS role the application connects as. */
export const APP_ROLE = "ssos_app";
