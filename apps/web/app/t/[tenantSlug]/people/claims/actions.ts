"use server";

import { revalidatePath } from "next/cache";

import { canApproveClaims, ClaimDecisionError, type ClaimErrorCode, decideClaim } from "../../../../../lib/join-claims";
import { requireTenant } from "../../../../../lib/session";

export type ClaimActionResult =
  | { status: "ok"; claimId: string; outcome: "active" | "rejected" }
  | { status: "error"; code: ClaimErrorCode | "forbidden" | "invalid_form" | "unexpected" };

/**
 * Approve or reject one join claim. Called by the pending-claims list only after its undo
 * window has passed. The permission is re-checked here; withTenant (RLS) bounds the claim
 * to this school, so another school's claim id is "not_found".
 */
export async function decideClaimAction(input: {
  tenantSlug: string;
  claimId: string;
  decision: "approve" | "reject";
  reason?: string;
}): Promise<ClaimActionResult> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof input?.tenantSlug !== "string" || typeof input.claimId !== "string" || !uuid.test(input.claimId)) {
    return { status: "error", code: "invalid_form" };
  }
  if (input.decision !== "approve" && input.decision !== "reject") return { status: "error", code: "invalid_form" };
  const { user, membership, viewer, db } = await requireTenant(input.tenantSlug);
  if (!canApproveClaims(viewer)) return { status: "error", code: "forbidden" };
  try {
    const result = await db((tx) =>
      decideClaim(tx, {
        tenantId: membership.tenantId,
        claimId: input.claimId,
        decision: input.decision,
        deciderPersonId: membership.personId,
        actorUserId: user.id,
        reason: typeof input.reason === "string" ? input.reason : null,
      }),
    );
    revalidatePath(`/t/${input.tenantSlug}`, "layout");
    return { status: "ok", claimId: result.claimId, outcome: result.status };
  } catch (err) {
    if (err instanceof ClaimDecisionError) return { status: "error", code: err.code };
    console.error("decideClaimAction failed", err);
    return { status: "error", code: "unexpected" };
  }
}
