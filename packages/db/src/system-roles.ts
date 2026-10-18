/** System roles (role.tenant_id IS NULL). Keys are stable; names are English defaults. */
export const SYSTEM_ROLES = [
  { key: "student", name: "Student" },
  { key: "parent", name: "Parent" },
  { key: "teacher", name: "Teacher" },
  { key: "advisor", name: "Advisor" },
  { key: "trainer", name: "Trainer" },
  { key: "admin", name: "Admin" },
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number]["key"];

/** Baseline permissions. The full RBAC service layer comes in a later slice. */
export const PERMISSIONS = [
  { key: "tenant.manage", description: "Manage school settings, units and roles" },
  { key: "roster.read", description: "View students, guardians, staff and classes" },
  { key: "roster.write", description: "Create and edit roster records" },
  { key: "roster.import", description: "Run CSV / OneRoster imports" },
  { key: "invitation.manage", description: "Create and revoke invitations" },
  { key: "guardianship.read_own", description: "View own linked students" },
  { key: "consent.manage_own", description: "Give or revoke consent for self or own children" },
  { key: "audit.read", description: "Read the audit log" },
] as const;

export const ROLE_PERMISSIONS: Record<SystemRoleKey, readonly (typeof PERMISSIONS)[number]["key"][]> = {
  admin: ["tenant.manage", "roster.read", "roster.write", "roster.import", "invitation.manage", "audit.read"],
  advisor: ["roster.read"],
  teacher: ["roster.read"],
  trainer: ["roster.read"],
  parent: ["guardianship.read_own", "consent.manage_own"],
  student: ["consent.manage_own"],
};
