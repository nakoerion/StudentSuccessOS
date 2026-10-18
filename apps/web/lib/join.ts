/**
 * "Join your school": a join code lets a user CLAIM a role (pending until a
 * school admin approves); an invitation code GRANTS its role immediately.
 * Codes are resolved through SECURITY DEFINER lookups; all writes then run
 * inside withTenant for the resolved tenant, so RLS checks them.
 */
import { invitationByCode, type PrismaClient, tenantByJoinCode, withTenant } from "@ssos/db";

/** Roles anyone holding the school's join code may ask for. */
export const CLAIMABLE_ROLES = ["student", "parent", "teacher"] as const;
export type ClaimableRole = (typeof CLAIMABLE_ROLES)[number];

export function isClaimableRole(value: unknown): value is ClaimableRole {
  return typeof value === "string" && (CLAIMABLE_ROLES as readonly string[]).includes(value);
}

export interface Joiner {
  userId: string;
  name: string | null;
  email: string;
}

export type CodeLookup =
  | { kind: "join"; tenantId: string; slug: string; name: string }
  | { kind: "invitation"; tenantId: string; slug: string; name: string; roleKey: string; invitationId: string; unitId: string | null }
  | { kind: "invalid" }
  | { kind: "used" };

export function normaliseCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 40) : "";
}

export async function lookupCode(raw: unknown, now = new Date(), client?: PrismaClient): Promise<CodeLookup> {
  const code = normaliseCode(raw);
  if (!code) return { kind: "invalid" };
  const inv = await invitationByCode(code, client);
  if (inv) {
    if (inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now) return { kind: "used" };
    return {
      kind: "invitation",
      tenantId: inv.tenantId,
      slug: inv.tenantSlug,
      name: inv.tenantName,
      roleKey: inv.roleKey,
      invitationId: inv.invitationId,
      unitId: inv.tenantUnitId,
    };
  }
  const t = await tenantByJoinCode(code, client);
  return t ? { kind: "join", tenantId: t.tenantId, slug: t.tenantSlug, name: t.tenantName } : { kind: "invalid" };
}

function splitName(joiner: Joiner): { givenName: string; familyName: string; displayName: string } {
  const display = (joiner.name?.trim() || joiner.email.split("@")[0] || "User").slice(0, 120);
  const parts = display.split(/\s+/);
  const givenName = parts[0] ?? display;
  const familyName = parts.slice(1).join(" ") || "-";
  return { givenName, familyName, displayName: display };
}

type AssignResult = { ok: true; slug: string; status: "active" | "pending" } | { ok: false; error: "invalid_code" | "code_used" | "invalid_role" };

/** Find-or-create the user's person in the tenant, then add the role assignment. */
async function assignRole(
  tenantId: string,
  joiner: Joiner,
  roleKey: string,
  status: "active" | "pending",
  extra: { unitId?: string | null; invitationId?: string },
  client?: PrismaClient,
): Promise<boolean> {
  return withTenant(
    tenantId,
    async (tx) => {
      if (extra.invitationId) {
        // Single use: claim the invitation atomically before granting anything.
        const claimed = await tx.invitation.updateMany({
          where: { id: extra.invitationId, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) return false;
      }
      const role = await tx.role.findFirst({ where: { key: roleKey, tenantId: null }, select: { id: true } });
      if (!role) return false;
      const person =
        (await tx.person.findFirst({ where: { userAccountId: joiner.userId }, select: { id: true } })) ??
        (await tx.person.create({
          data: { tenantId, userAccountId: joiner.userId, ...splitName(joiner) },
          select: { id: true },
        }));
      const existing = await tx.roleAssignment.findFirst({ where: { personId: person.id, roleId: role.id } });
      if (existing) {
        if (status === "active" && existing.status !== "active") {
          await tx.roleAssignment.update({ where: { id: existing.id }, data: { status: "active" } });
        }
        return true;
      }
      await tx.roleAssignment.create({
        data: { tenantId, personId: person.id, roleId: role.id, status, tenantUnitId: extra.unitId ?? null },
      });
      if (extra.invitationId) {
        await tx.invitation.update({ where: { id: extra.invitationId }, data: { personId: person.id } });
      }
      return true;
    },
    { userId: joiner.userId, client },
  );
}

/** Join code + chosen role -> pending assignment. */
export async function claimRoleWithJoinCode(
  joiner: Joiner,
  rawCode: unknown,
  roleKey: unknown,
  client?: PrismaClient,
): Promise<AssignResult> {
  if (!isClaimableRole(roleKey)) return { ok: false, error: "invalid_role" };
  const found = await lookupCode(rawCode, new Date(), client);
  if (found.kind !== "join") return { ok: false, error: "invalid_code" };
  const ok = await assignRole(found.tenantId, joiner, roleKey, "pending", {}, client);
  return ok ? { ok: true, slug: found.slug, status: "pending" } : { ok: false, error: "invalid_code" };
}

/** Invitation code -> active assignment for the invitation's role. */
export async function acceptInvitationCode(joiner: Joiner, rawCode: unknown, client?: PrismaClient): Promise<AssignResult> {
  const found = await lookupCode(rawCode, new Date(), client);
  if (found.kind === "used") return { ok: false, error: "code_used" };
  if (found.kind !== "invitation") return { ok: false, error: "invalid_code" };
  const ok = await assignRole(
    found.tenantId,
    joiner,
    found.roleKey,
    "active",
    { unitId: found.unitId, invitationId: found.invitationId },
    client,
  );
  return ok ? { ok: true, slug: found.slug, status: "active" } : { ok: false, error: "code_used" };
}
