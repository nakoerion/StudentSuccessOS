/**
 * Typed wrappers over the SECURITY DEFINER lookup functions. These are the
 * ONLY way the runtime role reaches `user_account` and other tenants' `tenant`
 * rows: each takes exactly one key and returns at most one subject's rows.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultClient } from "./client";

export type MembershipStatus = "active" | "pending";

export interface MembershipRow {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  defaultLocale: string;
  personId: string;
  /** NULL when the person exists in the tenant but holds no role. */
  roleKey: string | null;
  status: MembershipStatus | null;
}

export interface SignInAccount {
  id: string;
  email: string;
  displayName: string | null;
  locale: string | null;
  passwordHash: string | null;
}

export interface JoinCodeTenant {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

export interface InvitationLookup extends JoinCodeTenant {
  invitationId: string;
  roleKey: string;
  tenantUnitId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export async function userMemberships(userId: string, client: PrismaClient = defaultClient): Promise<MembershipRow[]> {
  const rows = await client.$queryRaw<
    {
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      default_locale: string;
      person_id: string;
      role_key: string | null;
      status: MembershipStatus | null;
    }[]
  >`SELECT * FROM ssos_user_memberships(${userId}::uuid)`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    defaultLocale: r.default_locale,
    personId: r.person_id,
    roleKey: r.role_key,
    status: r.status,
  }));
}

export async function accountForSignIn(
  email: string,
  client: PrismaClient = defaultClient,
): Promise<SignInAccount | null> {
  const rows = await client.$queryRaw<
    { id: string; email: string; display_name: string | null; locale: string | null; password_hash: string | null }[]
  >`SELECT * FROM ssos_account_for_sign_in(${email})`;
  const r = rows[0];
  return r
    ? { id: r.id, email: r.email, displayName: r.display_name, locale: r.locale, passwordHash: r.password_hash }
    : null;
}

export async function recordSignIn(userId: string, client: PrismaClient = defaultClient): Promise<void> {
  await client.$executeRaw`SELECT ssos_record_sign_in(${userId}::uuid)`;
}

export async function tenantByJoinCode(
  code: string,
  client: PrismaClient = defaultClient,
): Promise<JoinCodeTenant | null> {
  const rows = await client.$queryRaw<{ tenant_id: string; tenant_slug: string; tenant_name: string }[]>`
    SELECT * FROM ssos_tenant_by_join_code(${code})`;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, tenantSlug: r.tenant_slug, tenantName: r.tenant_name } : null;
}

export async function invitationByCode(
  code: string,
  client: PrismaClient = defaultClient,
): Promise<InvitationLookup | null> {
  const rows = await client.$queryRaw<
    {
      invitation_id: string;
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      role_key: string;
      tenant_unit_id: string | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }[]
  >`SELECT * FROM ssos_invitation_by_code(${code})`;
  const r = rows[0];
  return r
    ? {
        invitationId: r.invitation_id,
        tenantId: r.tenant_id,
        tenantSlug: r.tenant_slug,
        tenantName: r.tenant_name,
        roleKey: r.role_key,
        tenantUnitId: r.tenant_unit_id,
        expiresAt: r.expires_at,
        acceptedAt: r.accepted_at,
        revokedAt: r.revoked_at,
      }
    : null;
}
