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
  /** Country-pack code of the tenant (e.g. "AL"), for pack-driven defaults. */
  countryCode: string;
  personId: string;
  /** NULL when the person exists in the tenant but holds no role. */
  roleKey: string | null;
  status: MembershipStatus | null;
}

/** The user_account linked to an auth-provider subject (user_account.external_auth_id). */
export interface AuthAccount {
  /** user_account.id — the app's identity (app.user_id, person.user_account_id). */
  id: string;
  email: string;
  displayName: string | null;
  locale: string | null;
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

/**
 * Memberships of the signed-in user. `ssos_user_memberships` only answers for
 * the caller identified by the transaction-local `app.user_id`, so the
 * setting and the call share one transaction (one physical connection).
 */
export async function userMemberships(userId: string, client: PrismaClient = defaultClient): Promise<MembershipRow[]> {
  const rows = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return tx.$queryRaw<
      {
        tenant_id: string;
        tenant_slug: string;
        tenant_name: string;
        default_locale: string;
        country_code: string;
        person_id: string;
        role_key: string | null;
        status: MembershipStatus | null;
      }[]
    >`SELECT * FROM ssos_user_memberships(${userId}::uuid)`;
  });
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    defaultLocale: r.default_locale,
    countryCode: r.country_code,
    personId: r.person_id,
    roleKey: r.role_key,
    status: r.status,
  }));
}

/**
 * Map a verified auth-provider subject (Supabase auth.users.id) to its
 * user_account by `external_auth_id`. If nothing is linked yet, an account is
 * provisioned for that subject (it has no roles, so it lands on "Join your
 * school"). Never links to an existing account by e-mail — returns null then.
 * Call ONLY with a subject taken from a verified session.
 */
export async function accountForAuthSubject(
  subject: { externalAuthId: string; email: string; displayName?: string | null },
  client: PrismaClient = defaultClient,
): Promise<AuthAccount | null> {
  const rows = await client.$queryRaw<
    { id: string; email: string; display_name: string | null; locale: string | null }[]
  >`SELECT * FROM ssos_account_for_auth(${subject.externalAuthId}, ${subject.email}, ${subject.displayName ?? null})`;
  const r = rows[0];
  return r ? { id: r.id, email: r.email, displayName: r.display_name, locale: r.locale } : null;
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
