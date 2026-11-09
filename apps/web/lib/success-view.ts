/**
 * Pure view helpers for the success-engine UI (no server imports: safe for client
 * components and unit tests). Nothing here branches on country.
 */

export const TRACKS = ["excellence", "growth", "support"] as const;
export type Track = (typeof TRACKS)[number];
export const BANDS = ["low", "moderate", "high", "critical"] as const;
export type Band = (typeof BANDS)[number];
export const DECISIONS = ["approve", "edit", "dismiss"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Error codes the decision action can return (service codes + action-level ones). */
export const DECISION_ERROR_CODES = [
  "unknown_card",
  "already_decided",
  "card_expired",
  "stale_card",
  "unknown_decider",
  "not_authorized",
  "unsupported_card_type",
  "invalid_decision",
  "invalid_payload",
  "invalid_form",
  "unexpected",
] as const;
export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number];

/** Alert rule keys with a translated label (other rules fall back to their stored name). */
export const KNOWN_ALERT_RULES = ["risk_high", "risk_critical", "attendance_low", "late_submissions"] as const;

/** Roles that may decide any card besides its assignee role (mirrors decideActionCard). */
export const CARD_OVERRIDE_ROLES = ["admin"] as const;

/** Whether the viewer's active roles let them decide a card assigned to `assigneeRole`. */
export function canDecideCard(viewerRoles: readonly string[], assigneeRole: string): boolean {
  return viewerRoles.includes(assigneeRole) || CARD_OVERRIDE_ROLES.some((r) => viewerRoles.includes(r));
}

export type ConfidenceLevel = "high" | "medium" | "low";
/** Bucket a 0–1 confidence for display: >= 0.75 high, >= 0.5 medium, else low. */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/** Badge variant per band / severity / state (design tokens only). */
export const BAND_VARIANT: Record<Band, "success" | "warn" | "danger" | "neutral"> = {
  low: "success",
  moderate: "neutral",
  high: "warn",
  critical: "danger",
};

export const TRACK_VARIANT: Record<Track, "success" | "default" | "warn"> = {
  excellence: "success",
  growth: "default",
  support: "warn",
};

export interface DecisionForm {
  tenantSlug: string;
  actionCardId: string;
  decision: Decision;
  note: string | null;
  edits?: { track?: Track; effectiveDate?: string; reviewDate?: string | null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const str = (v: FormDataEntryValue | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/**
 * Validate the decision form posted by ActionInbox. Returns null for anything malformed.
 * `edit` sends only the fields the advisor changed (empty = unchanged); a review date can
 * be cleared explicitly with `clearReview=1`. Service rules (e.g. edit needs a change) stay
 * in decideActionCard.
 */
export function parseDecisionForm(fd: FormData): DecisionForm | null {
  const tenantSlug = str(fd.get("tenantSlug"));
  const actionCardId = str(fd.get("actionCardId"));
  const decision = str(fd.get("decision"));
  if (!SLUG_RE.test(tenantSlug) || !UUID_RE.test(actionCardId)) return null;
  if (!(DECISIONS as readonly string[]).includes(decision)) return null;
  const noteRaw = str(fd.get("note"));
  if (noteRaw.length > 1000) return null;
  const out: DecisionForm = { tenantSlug, actionCardId, decision: decision as Decision, note: noteRaw || null };
  if (decision !== "edit") return out;

  const edits: NonNullable<DecisionForm["edits"]> = {};
  const track = str(fd.get("track"));
  if (track) {
    if (!(TRACKS as readonly string[]).includes(track)) return null;
    edits.track = track as Track;
  }
  const effective = str(fd.get("effectiveDate"));
  if (effective) {
    if (!DATE_RE.test(effective)) return null;
    edits.effectiveDate = effective;
  }
  const review = str(fd.get("reviewDate"));
  if (str(fd.get("clearReview")) === "1") edits.reviewDate = null;
  else if (review) {
    if (!DATE_RE.test(review)) return null;
    edits.reviewDate = review;
  }
  out.edits = edits;
  return out;
}

export type SlaStatus = { kind: "none" } | { kind: "due"; minutesLeft: number } | { kind: "overdue"; minutesOver: number };
/** SLA timer state of an alert at `now` (no due time = timer stopped, e.g. acknowledged). */
export function slaStatus(dueAt: Date | null, now: Date): SlaStatus {
  if (!dueAt) return { kind: "none" };
  const diff = Math.round((dueAt.getTime() - now.getTime()) / 60_000);
  return diff >= 0 ? { kind: "due", minutesLeft: diff } : { kind: "overdue", minutesOver: -diff };
}

/** Split minutes into whole days / hours / minutes for "2d 4h" style display. */
export function splitMinutes(total: number): { days: number; hours: number; minutes: number } {
  const t = Math.max(0, Math.floor(total));
  return { days: Math.floor(t / 1440), hours: Math.floor((t % 1440) / 60), minutes: t % 60 };
}

export interface LadderStep {
  level: number;
  role: string;
  slaMinutes: number;
}
/** The rung an alert is on: 1-based position, total rungs and the rung's role. */
export function currentRung(ladder: readonly LadderStep[], escalationLevel: number, assigneeRole: string): { rung: number; of: number; role: string } {
  const sorted = [...ladder].sort((a, b) => a.level - b.level);
  const idx = sorted.findIndex((s) => s.level === escalationLevel);
  return { rung: idx >= 0 ? idx + 1 : escalationLevel + 1, of: Math.max(sorted.length, escalationLevel + 1), role: sorted[idx]?.role ?? assigneeRole };
}

/** Parse the alert rule's escalation JSON leniently for display (invalid steps dropped). */
export function readLadder(raw: unknown): LadderStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s: unknown) => {
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    return typeof o.level === "number" && typeof o.role === "string" && typeof o.slaMinutes === "number"
      ? [{ level: o.level, role: o.role, slaMinutes: o.slaMinutes }]
      : [];
  });
}

export interface AckView {
  personId: string;
  role: string;
  at: string;
  level: number;
  note?: string;
}
export function readAcknowledgements(raw: unknown): AckView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a: unknown) => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    if (typeof o.personId !== "string" || typeof o.role !== "string" || typeof o.at !== "string") return [];
    return [{ personId: o.personId, role: o.role, at: o.at, level: typeof o.level === "number" ? o.level : 0, ...(typeof o.note === "string" ? { note: o.note } : {}) }];
  });
}

/** Sum of contributions in cents (exact) — the panel shows it equals the score. */
export function sumContributions(factors: readonly { contribution: number }[]): number {
  return factors.reduce((a, f) => a + Math.round(f.contribution * 100), 0) / 100;
}

/** Bar width (%) of a value against a max, clamped to 0–100. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, (Math.abs(value) / max) * 100));
}
