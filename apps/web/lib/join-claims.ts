/**
 * Pending join claims: a person who joined with the school's join code holds a
 * role_assignment in status "pending" until someone with `invitation.manage` (letting
 * people into the school — seeded for admin) approves or rejects it.
 *
 * Every function takes a TenantTx from withTenant, so RLS bounds it to one school: a
 * claim id from another school simply is not found.
 */
import type { TenantTx } from "@ssos/db";

import type { Viewer } from "./access";

export const REJECT_REASON_MAX = 280;

/** Approving lets someone into the school: the same permission as inviting them. */
export function canApproveClaims(viewer: Viewer): boolean {
  return viewer.permissions.has("invitation.manage");
}

export interface PendingClaim {
  id: string;
  personId: string;
  name: string;
  email: string | null;
  roleKey: string;
  claimedAt: Date;
}

export async function countPendingClaims(tx: TenantTx): Promise<number> {
  return tx.roleAssignment.count({ where: { status: "pending" } });
}

export async function listPendingClaims(tx: TenantTx): Promise<PendingClaim[]> {
  const rows = await tx.roleAssignment.findMany({
    where: { status: "pending" },
    select: {
      id: true,
      personId: true,
      claimedAt: true,
      createdAt: true,
      person: { select: { displayName: true } },
      role: { select: { key: true } },
    },
    orderBy: [{ claimedAt: "asc" }, { createdAt: "asc" }],
  });
  const emails = await tx.$queryRaw<{ person_id: string; email: string }[]>`SELECT * FROM ssos_pending_claimant_emails()`;
  const byPerson = new Map(emails.map((e) => [e.person_id, e.email]));
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    name: r.person.displayName,
    email: byPerson.get(r.personId) ?? null,
    roleKey: r.role.key,
    claimedAt: r.claimedAt ?? r.createdAt,
  }));
}

export type ClaimDecision = "approve" | "reject";
export type ClaimErrorCode = "not_found" | "already_decided" | "reason_too_long";

export class ClaimDecisionError extends Error {
  constructor(readonly code: ClaimErrorCode) {
    super(code);
  }
}

export interface DecideClaimInput {
  tenantId: string;
  claimId: string;
  decision: ClaimDecision;
  deciderPersonId: string;
  actorUserId: string;
  reason?: string | null;
}

export interface DecideClaimResult {
  claimId: string;
  status: "active" | "rejected";
  /** False when the claim was already in this state (a repeat approval): nothing written. */
  changed: boolean;
}

/**
 * Approve -> the assignment becomes active (the person is now a member at the claimed
 * role); reject -> marked rejected, no membership. Each real change writes exactly one
 * `event` row in the same transaction. The status flip is conditional on "pending", so two
 * concurrent approvals change it once; a repeat approval is a no-op, not an error.
 */
export async function decideClaim(tx: TenantTx, input: DecideClaimInput): Promise<DecideClaimResult> {
  const reason = input.decision === "reject" ? input.reason?.trim() || null : null;
  if (reason && reason.length > REJECT_REASON_MAX) throw new ClaimDecisionError("reason_too_long");
  const target = input.decision === "approve" ? "active" : "rejected";

  const claim = await tx.roleAssignment.findUnique({
    where: { id: input.claimId },
    select: { id: true, personId: true, status: true, claimedAt: true, role: { select: { key: true } } },
  });
  if (!claim) throw new ClaimDecisionError("not_found");

  const now = new Date();
  const flipped = await tx.roleAssignment.updateMany({
    where: { id: claim.id, status: "pending" },
    data: { status: target, decidedAt: now, decisionReason: reason },
  });
  if (flipped.count !== 1) {
    const current = await tx.roleAssignment.findUnique({ where: { id: claim.id }, select: { status: true } });
    if (current?.status === target) return { claimId: claim.id, status: target, changed: false };
    throw new ClaimDecisionError("already_decided");
  }

  await tx.event.create({
    data: {
      tenantId: input.tenantId,
      actorPersonId: input.deciderPersonId,
      actorUserId: input.actorUserId,
      subjectPersonId: claim.personId,
      type: input.decision === "approve" ? "join_claim.approved" : "join_claim.rejected",
      entityType: "role_assignment",
      entityId: claim.id,
      payload: { role: claim.role.key, ...(reason ? { reason } : {}), claimedAt: claim.claimedAt?.toISOString() ?? null },
    },
  });
  return { claimId: claim.id, status: target, changed: true };
}

/** The signed-in claimant's own refused claims in one school, with the reason given. */
export async function ownRejectedClaims(tx: TenantTx, personId: string): Promise<{ roleKey: string; reason: string | null }[]> {
  const rows = await tx.roleAssignment.findMany({
    where: { personId, status: "rejected" },
    select: { decisionReason: true, role: { select: { key: true } } },
  });
  return rows.map((r) => ({ roleKey: r.role.key, reason: r.decisionReason }));
}
