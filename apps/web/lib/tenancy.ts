/**
 * Tenant resolution: turn the rows from ssos_user_memberships() into "where
 * should this user land?". Pure functions — unit-tested without a database.
 */
import type { MembershipRow } from "@ssos/db";

export interface TenantMembership {
  tenantId: string;
  slug: string;
  name: string;
  defaultLocale: string;
  personId: string;
  activeRoles: string[];
  pendingRoles: string[];
}

export type Landing =
  | { kind: "join" }
  | { kind: "pending"; schools: TenantMembership[] }
  | { kind: "tenant"; slug: string }
  | { kind: "picker"; schools: TenantMembership[] };

/** Group membership rows by tenant, splitting active and pending roles. */
export function groupMemberships(rows: readonly MembershipRow[]): TenantMembership[] {
  const byTenant = new Map<string, TenantMembership>();
  for (const r of rows) {
    let m = byTenant.get(r.tenantId);
    if (!m) {
      m = {
        tenantId: r.tenantId,
        slug: r.tenantSlug,
        name: r.tenantName,
        defaultLocale: r.defaultLocale,
        personId: r.personId,
        activeRoles: [],
        pendingRoles: [],
      };
      byTenant.set(r.tenantId, m);
    }
    if (!r.roleKey) continue;
    const list = r.status === "pending" ? m.pendingRoles : m.activeRoles;
    if (!list.includes(r.roleKey)) list.push(r.roleKey);
  }
  return [...byTenant.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tenants where the user holds at least one active role. */
export function activeTenants(rows: readonly MembershipRow[]): TenantMembership[] {
  return groupMemberships(rows).filter((m) => m.activeRoles.length > 0);
}

/**
 * 0 active memberships -> "Join your school" (or "waiting for approval" if a
 * claim is pending); 1 -> straight to that school; more -> school picker.
 */
export function resolveLanding(rows: readonly MembershipRow[]): Landing {
  const all = groupMemberships(rows);
  const active = all.filter((m) => m.activeRoles.length > 0);
  if (active.length === 1) return { kind: "tenant", slug: active[0]!.slug };
  if (active.length > 1) return { kind: "picker", schools: active };
  const pending = all.filter((m) => m.pendingRoles.length > 0);
  if (pending.length > 0) return { kind: "pending", schools: pending };
  return { kind: "join" };
}

/** The membership for a URL slug, only if the user is active there. */
export function membershipForSlug(rows: readonly MembershipRow[], slug: string): TenantMembership | null {
  return activeTenants(rows).find((m) => m.slug === slug) ?? null;
}

export function landingPath(landing: Landing): string {
  switch (landing.kind) {
    case "tenant":
      return `/t/${landing.slug}`;
    case "picker":
      return "/schools";
    case "pending":
    case "join":
      return "/join";
  }
}
