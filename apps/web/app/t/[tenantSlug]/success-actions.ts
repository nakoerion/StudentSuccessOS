"use server";

import { ActionCardError, decideActionCard } from "@ssos/db";
import { revalidatePath } from "next/cache";

import { requireTenant } from "../../../lib/session";
import { DECISION_ERROR_CODES, parseDecisionForm, type DecisionErrorCode } from "../../../lib/success-view";

export type DecisionState =
  | { status: "idle" }
  | { status: "ok"; actionCardId: string; outcome: "approved" | "edited" | "dismissed"; track: string | null }
  | { status: "error"; code: DecisionErrorCode };

/**
 * Approve / edit / dismiss one action card (ActionInbox). The decider is the signed-in
 * person of the tenant in the form; decideActionCard runs inside withTenant (RLS) and
 * enforces the role rule, the single decision and the one-event-per-mutation invariant.
 */
export async function decideCardAction(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const form = parseDecisionForm(formData);
  if (!form) return { status: "error", code: "invalid_form" };
  const { user, membership, db } = await requireTenant(form.tenantSlug);
  try {
    const result = await db((tx) =>
      decideActionCard(tx, {
        tenantId: membership.tenantId,
        actionCardId: form.actionCardId,
        decision: form.decision,
        deciderPersonId: membership.personId,
        actorUserId: user.id,
        note: form.note,
        ...(form.edits ? { edits: form.edits } : {}),
      }),
    );
    revalidatePath(`/t/${form.tenantSlug}`, "layout");
    return { status: "ok", actionCardId: result.actionCardId, outcome: result.status, track: result.trackAssignment?.track ?? null };
  } catch (err) {
    if (err instanceof ActionCardError && (DECISION_ERROR_CODES as readonly string[]).includes(err.code)) {
      return { status: "error", code: err.code };
    }
    console.error("decideCardAction failed", err);
    return { status: "error", code: "unexpected" };
  }
}
