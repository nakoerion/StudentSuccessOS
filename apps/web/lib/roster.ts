/**
 * Roster queries. The scope (all vs. own children) is applied in the WHERE
 * clause on the server — a parent's request never loads other students.
 */
import type { Prisma, TenantTx } from "@ssos/db";

import type { RosterScope } from "./access";

export const ROSTER_ROLES = ["student", "teacher", "parent"] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];
export type RosterFilter = RosterRole | "all";

export function parseRosterFilter(value: unknown): RosterFilter {
  return typeof value === "string" && (ROSTER_ROLES as readonly string[]).includes(value)
    ? (value as RosterRole)
    : "all";
}

export interface RosterRow {
  id: string;
  displayName: string;
  externalRef: string | null;
  roles: string[];
  units: string[];
  guardians: { id: string; displayName: string; relationship: string }[];
  children: { id: string; displayName: string }[];
}

export interface RosterQuery {
  filter: RosterFilter;
  search?: string;
}

/** Build the Prisma WHERE for a scope + filter. Exported for unit tests. */
export function rosterWhere(scope: RosterScope, query: RosterQuery): Prisma.PersonWhereInput | null {
  if (scope.kind === "none") return null;
  const roleKeys: readonly string[] =
    scope.kind === "own_children" ? ["student"] : query.filter === "all" ? ROSTER_ROLES : [query.filter];
  const and: Prisma.PersonWhereInput[] = [
    { roleAssignments: { some: { status: "active", role: { key: { in: [...roleKeys] } } } } },
  ];
  if (scope.kind === "own_children") {
    and.push({ guardedBy: { some: { guardianPersonId: scope.guardianPersonId } } });
  }
  const search = query.search?.trim();
  if (search) {
    and.push({
      OR: [
        { displayName: { contains: search, mode: "insensitive" } },
        { externalRef: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  return { AND: and };
}

export async function listRoster(tx: TenantTx, scope: RosterScope, query: RosterQuery): Promise<RosterRow[]> {
  const where = rosterWhere(scope, query);
  if (!where) return [];
  const people = await tx.person.findMany({
    where,
    orderBy: [{ familyName: "asc" }, { givenName: "asc" }],
    take: 500,
    select: {
      id: true,
      displayName: true,
      externalRef: true,
      roleAssignments: {
        where: { status: "active" },
        select: { role: { select: { key: true } }, tenantUnit: { select: { name: true } } },
      },
      guardedBy: {
        orderBy: { isPrimary: "desc" },
        select: { relationship: true, guardian: { select: { id: true, displayName: true } } },
      },
      guardianOf: { select: { student: { select: { id: true, displayName: true } } } },
    },
  });
  return people.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    externalRef: p.externalRef,
    roles: [...new Set(p.roleAssignments.map((a) => a.role.key))],
    units: [...new Set(p.roleAssignments.flatMap((a) => (a.tenantUnit ? [a.tenantUnit.name] : [])))],
    guardians: p.guardedBy.map((g) => ({ ...g.guardian, relationship: g.relationship })),
    // A parent viewer only ever receives students, so this is empty for them.
    children: scope.kind === "all" ? p.guardianOf.map((g) => g.student) : [],
  }));
}

export interface DashboardCounts {
  students: number;
  teachers: number;
  parents: number;
  classes: number;
}

export async function dashboardCounts(tx: TenantTx): Promise<DashboardCounts> {
  const byRole = (key: string) =>
    tx.person.count({ where: { roleAssignments: { some: { status: "active", role: { key } } } } });
  // Sequential on purpose: one interactive transaction = one connection.
  const students = await byRole("student");
  const teachers = await byRole("teacher");
  const parents = await byRole("parent");
  const classes = await tx.tenantUnit.count({ where: { kind: "class" } });
  return { students, teachers, parents, classes };
}

export async function pendingClaimsCount(tx: TenantTx): Promise<number> {
  return tx.roleAssignment.count({ where: { status: "pending" } });
}
