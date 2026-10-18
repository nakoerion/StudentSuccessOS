// Server-only module (reads the session and the database).
import { getSessionUser, type SessionUser } from "@ssos/auth";
import { userMemberships, withTenant, type TenantTx } from "@ssos/db";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { loadViewer, type Viewer } from "./access";
import { groupMemberships, membershipForSlug, type TenantMembership } from "./tenancy";

/** Raw membership rows for a user, memoised per request. */
export const getMembershipRows = cache((userId: string) => userMemberships(userId));

/** Grouped memberships (active and pending) for a user, memoised per request. */
export const getMemberships = cache(async (userId: string) => groupMemberships(await getMembershipRows(userId)));

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

export interface TenantContext {
  user: SessionUser;
  membership: TenantMembership;
  viewer: Viewer;
  /** Run DB work for this tenant + user. Every page query goes through here. */
  db: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

/**
 * Resolve /t/[tenantSlug] for the signed-in user. 404s (not 403) when the user
 * has no active role there, so tenant slugs can't be probed.
 */
export const requireTenant = cache(async (slug: string): Promise<TenantContext> => {
  const user = await requireUser();
  const membership = membershipForSlug(await getMembershipRows(user.id), slug);
  if (!membership) notFound();
  const db = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(membership.tenantId, fn, { userId: user.id });
  const viewer = await db((tx) => loadViewer(tx, membership.personId));
  return { user, membership, viewer, db };
});
