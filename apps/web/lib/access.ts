/**
 * Who may see what inside a tenant. Decisions are driven by permission keys
 * from role_permission (seeded per system role), never by role names or
 * country. All queries run inside withTenant, so RLS bounds them to the tenant.
 */
import type { TenantTx } from "@ssos/db";

export interface Viewer {
  personId: string;
  roles: string[];
  permissions: Set<string>;
}

/** What slice of the roster a viewer may read. */
export type RosterScope = { kind: "all" } | { kind: "own_children"; guardianPersonId: string } | { kind: "none" };

export async function loadViewer(tx: TenantTx, personId: string): Promise<Viewer> {
  const assignments = await tx.roleAssignment.findMany({
    where: { personId, status: "active" },
    select: {
      role: {
        select: { key: true, rolePermissions: { select: { permission: { select: { key: true } } } } },
      },
    },
  });
  const roles = [...new Set(assignments.map((a) => a.role.key))];
  const permissions = new Set(assignments.flatMap((a) => a.role.rolePermissions.map((rp) => rp.permission.key)));
  return { personId, roles, permissions };
}

export function rosterScope(viewer: Viewer): RosterScope {
  if (viewer.permissions.has("roster.read")) return { kind: "all" };
  if (viewer.permissions.has("guardianship.read_own")) {
    return { kind: "own_children", guardianPersonId: viewer.personId };
  }
  return { kind: "none" };
}
