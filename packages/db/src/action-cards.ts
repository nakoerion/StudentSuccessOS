/**
 * Track transitions as action cards (success engine slice 3a). Service layer only.
 *
 * A risk recompute never changes a student's track. It PROPOSES a transition as an
 * `action_card` (type track_transition, status proposed, assignee advisor) with evidence
 * (the risk_score it came from + its top factors) and a confidence. Only a human decision
 * (`decideActionCard`: approve / edit / dismiss) applies it: approving writes the
 * `track_assignment` with effective and review dates and retires the previous one.
 *
 * The database enforces the same rule independently of this file (migration
 * 20261106000200_success_engine_jobs): a `track_assignment` row can only be inserted for an
 * approved/edited track_transition card about the same student and track, may afterwards
 * only be retired, and a card is born `proposed` and decided exactly once.
 *
 * Track rule (identical for every tenant and country, TRACK_RULES):
 *   support     band high or critical;
 *   excellence  band low AND mean grade level >= excellenceMinGradeLevel %;
 *   growth      otherwise.
 * A student without any track assignment counts as `growth` (the default track), so the
 * engine only proposes excellence or support for them — no flood of "growth" cards.
 *
 * Confidence (0–1, 3 dp) = coverage × (0.5 + 0.5 × min(1, margin / marginForFull)):
 *   coverage  share of the configured weight whose factors had data;
 *   margin    score points between the score and the nearest band threshold (for
 *             excellence also the grade-level points above the excellence bar) — a score
 *             sitting on a band boundary is a weak signal.
 *
 * Every card mutation writes exactly one `event` row in the same transaction
 * (action_card.proposed | .expired | .approved | .edited | .dismissed).
 */
import { Prisma, type PrismaClient, type RiskBand, type StudentTrack } from "@prisma/client";

import type { BandThresholds, RiskFactorResult, RiskScoreView } from "./risk-model";

type Db = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ActionCardErrorCode =
  | "unknown_card"
  | "already_decided"
  | "card_expired"
  | "stale_card"
  | "unknown_decider"
  | "not_authorized"
  | "unsupported_card_type"
  | "invalid_decision"
  | "invalid_payload";

/** Thrown for a decision that cannot be applied. Nothing is written. */
export class ActionCardError extends Error {
  readonly code: ActionCardErrorCode;
  constructor(code: ActionCardErrorCode, message: string) {
    super(message);
    this.name = "ActionCardError";
    this.code = code;
  }
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export const STUDENT_TRACKS = ["excellence", "growth", "support"] as const satisfies readonly StudentTrack[];

/** Product conventions for track proposals — the same for every tenant and country. */
export const TRACK_RULES = {
  supportBands: ["high", "critical"] as readonly RiskBand[],
  excellenceBand: "low" as RiskBand,
  /** Mean grade level (%) needed, besides a low band, for excellence. */
  excellenceMinGradeLevel: 85,
  /** Track of a student who has no track assignment yet. */
  defaultTrack: "growth" as StudentTrack,
  /** Default review date = effective date + this many days. */
  reviewAfterDays: 42,
  /** An undecided proposal expires after this many days. */
  cardExpiresAfterDays: 14,
  /** Margin (score points) at which the margin part of the confidence is full. */
  marginForFull: 10,
  /** Role expected to decide track cards (admins may always decide). */
  assigneeRole: "advisor",
} as const;

/** Roles allowed to decide a card besides its assignee role. */
const OVERRIDE_ROLES = ["admin"] as const;

export interface TrackProposalBasis {
  track: StudentTrack;
  rule: "band_high_or_critical" | "band_low_and_grades_high" | "otherwise";
  coverage: number;
  margin: number;
  confidence: number;
}

const round3 = (n: Prisma.Decimal) => n.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toNumber();
const round2 = (n: Prisma.Decimal) => n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

/** Pure: the track a risk score points to, with the confidence of that reading. */
export function proposeTrack(score: { score: number; band: RiskBand; factors: RiskFactorResult[] }, thresholds: BandThresholds): TrackProposalBasis {
  const s = new Decimal(score.score);
  const gradeLevel = score.factors.find((f) => f.factor === "gradeLevel");
  const grade = gradeLevel?.available && gradeLevel.value !== null ? new Decimal(gradeLevel.value) : null;

  let track: StudentTrack;
  let rule: TrackProposalBasis["rule"];
  if (TRACK_RULES.supportBands.includes(score.band)) {
    track = "support";
    rule = "band_high_or_critical";
  } else if (score.band === TRACK_RULES.excellenceBand && grade !== null && grade.gte(TRACK_RULES.excellenceMinGradeLevel)) {
    track = "excellence";
    rule = "band_low_and_grades_high";
  } else {
    track = "growth";
    rule = "otherwise";
  }

  const totalWeight = score.factors.reduce((a, f) => a.plus(f.weight), new Decimal(0));
  const availWeight = score.factors.filter((f) => f.available).reduce((a, f) => a.plus(f.weight), new Decimal(0));
  const coverage = totalWeight.gt(0) ? availWeight.div(totalWeight) : new Decimal(0);
  let margin = Decimal.min(...[thresholds.moderate, thresholds.high, thresholds.critical].map((t) => s.minus(t).abs()));
  if (track === "excellence" && grade !== null) margin = Decimal.min(margin, grade.minus(TRACK_RULES.excellenceMinGradeLevel));
  const marginPart = new Decimal(0.5).plus(new Decimal(0.5).mul(Decimal.min(1, margin.div(TRACK_RULES.marginForFull))));
  const confidence = Decimal.max(0, Decimal.min(1, coverage.mul(marginPart)));
  return { track, rule, coverage: round3(coverage), margin: round2(margin), confidence: round3(confidence) };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPrismaClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === "function";
}
function inTx<T>(db: PrismaClient | Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return isPrismaClient(db) ? db.$transaction(fn, { timeout: 60_000, maxWait: 30_000 }) : fn(db);
}

/** UTC calendar date (time stripped). */
const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
function parseDate(v: unknown, what: string): Date {
  if (typeof v !== "string" || !DATE_RE.test(v)) throw new ActionCardError("invalid_payload", `${what} must be a YYYY-MM-DD date`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== v) throw new ActionCardError("invalid_payload", `${what} is not a valid date`);
  return d;
}

/** Serialises proposals and decisions about one student's track. */
async function lockStudentTrack(db: Db, tenantId: string, studentPersonId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssos:track:${tenantId}:${studentPersonId}`}))`;
}

export interface TrackTransitionPayload {
  track: StudentTrack;
  /** Current track when proposed (null = no assignment yet; counts as the default track). */
  fromTrack: StudentTrack | null;
  /** The active assignment the proposal would replace (stale check on approval). */
  currentTrackAssignmentId: string | null;
  riskScoreId: string;
  score: number;
  band: RiskBand;
  modelVersion: number;
  topFactors: { factor: string; contribution: number; vsBaseline: number | null }[];
  basis: TrackProposalBasis;
  reviewAfterDays: number;
}

// ─── Proposals ───────────────────────────────────────────────────────────────

export type TrackProposalResult =
  | { status: "proposed"; actionCardId: string; track: StudentTrack; fromTrack: StudentTrack | null; confidence: number; expiredCardId: string | null }
  | { status: "already_proposed"; actionCardId: string; track: StudentTrack }
  | { status: "no_change"; track: StudentTrack; expiredCardId: string | null };

async function expireCard(tx: Db, tenantId: string, card: { id: string; subjectPersonId: string }, reason: string, now: Date): Promise<void> {
  await tx.actionCard.update({ where: { id: card.id }, data: { status: "expired", decisionNote: reason } });
  await tx.event.create({
    data: {
      tenantId,
      type: "action_card.expired",
      subjectPersonId: card.subjectPersonId,
      entityType: "action_card",
      entityId: card.id,
      payload: { reason, at: now.toISOString() },
    },
  });
}

/**
 * Turn one fresh risk score into at most one open track-transition proposal for its
 * student. Never touches `track_assignment`. Runs inside the recompute's transaction on
 * the owner role. Idempotent: the same target as the open proposal is left alone; a
 * different target expires the open card and proposes anew; a target equal to the current
 * track expires any open card.
 */
export async function proposeTrackTransition(
  tx: Db,
  input: { tenantId: string; riskScore: RiskScoreView; thresholds: BandThresholds; now?: Date },
): Promise<TrackProposalResult> {
  const { tenantId, riskScore } = input;
  const now = input.now ?? new Date();
  const student = riskScore.studentPersonId;
  await lockStudentTrack(tx, tenantId, student);
  const basis = proposeTrack(riskScore, input.thresholds);

  const [current, openCards] = await Promise.all([
    tx.trackAssignment.findFirst({ where: { tenantId, studentPersonId: student, status: "active" }, select: { id: true, track: true } }),
    tx.actionCard.findMany({ where: { tenantId, subjectPersonId: student, type: "track_transition", status: "proposed" }, select: { id: true, subjectPersonId: true, proposedPayload: true, expiresAt: true } }),
  ]);
  let open = openCards[0] ?? null;
  if (open && open.expiresAt && open.expiresAt <= now) {
    await expireCard(tx, tenantId, open, "expired_undecided", now);
    open = null;
  }
  const currentTrack = current?.track ?? TRACK_RULES.defaultTrack;

  if (basis.track === currentTrack) {
    if (open) await expireCard(tx, tenantId, open, "no_longer_indicated", now);
    return { status: "no_change", track: currentTrack, expiredCardId: open?.id ?? null };
  }
  const openTrack = open ? (open.proposedPayload as { track?: string } | null)?.track : undefined;
  if (open && openTrack === basis.track) return { status: "already_proposed", actionCardId: open.id, track: basis.track };
  if (open) await expireCard(tx, tenantId, open, "superseded_by_new_proposal", now);

  const payload: TrackTransitionPayload = {
    track: basis.track,
    fromTrack: current?.track ?? null,
    currentTrackAssignmentId: current?.id ?? null,
    riskScoreId: riskScore.id,
    score: riskScore.score,
    band: riskScore.band,
    modelVersion: riskScore.modelVersion,
    topFactors: riskScore.factors.filter((f) => f.top).map((f) => ({ factor: f.factor, contribution: f.contribution, vsBaseline: f.vsBaseline })),
    basis,
    reviewAfterDays: TRACK_RULES.reviewAfterDays,
  };
  const evidenceRefs = [{ type: "risk_score", id: riskScore.id }];
  const card = await tx.actionCard.create({
    data: {
      tenantId,
      type: "track_transition",
      subjectPersonId: student,
      evidenceRefs,
      confidence: new Decimal(basis.confidence),
      proposedPayload: payload as unknown as Prisma.InputJsonValue,
      assigneeRole: TRACK_RULES.assigneeRole,
      sourceRiskScoreId: riskScore.id,
      expiresAt: new Date(now.getTime() + TRACK_RULES.cardExpiresAfterDays * DAY_MS),
    },
    select: { id: true },
  });
  await tx.event.create({
    data: {
      tenantId,
      type: "action_card.proposed",
      subjectPersonId: student,
      entityType: "action_card",
      entityId: card.id,
      payload: { cardType: "track_transition", track: basis.track, fromTrack: payload.fromTrack, confidence: basis.confidence, score: riskScore.score, band: riskScore.band },
      evidenceRefs,
    },
  });
  return { status: "proposed", actionCardId: card.id, track: basis.track, fromTrack: payload.fromTrack, confidence: basis.confidence, expiredCardId: open?.id ?? null };
}

/** Expire every undecided card of a tenant whose expires_at has passed (one event each). OWNER or app role. */
export function expireStaleActionCards(db: PrismaClient | Db, input: { tenantId: string; now?: Date }): Promise<number> {
  return inTx(db, async (tx) => {
    const now = input.now ?? new Date();
    const stale = await tx.actionCard.findMany({
      where: { tenantId: input.tenantId, status: "proposed", expiresAt: { lte: now } },
      select: { id: true, subjectPersonId: true },
      orderBy: { id: "asc" },
    });
    for (const card of stale) await expireCard(tx, input.tenantId, card, "expired_undecided", now);
    return stale.length;
  });
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export type ActionCardDecision = "approve" | "edit" | "dismiss";

export interface TrackEdits {
  track?: StudentTrack;
  /** YYYY-MM-DD; default: today. */
  effectiveDate?: string;
  /** YYYY-MM-DD or null (no review); default: effective date + reviewAfterDays. */
  reviewDate?: string | null;
}

export interface DecideActionCardInput {
  tenantId: string;
  actionCardId: string;
  decision: ActionCardDecision;
  /** The person deciding: must hold the card's assignee role (or admin) in the tenant. */
  deciderPersonId: string;
  actorUserId?: string | null;
  note?: string | null;
  /** approve: optional dates; edit: at least one change (track and/or dates). */
  edits?: TrackEdits;
  /** Clock (tests). */
  now?: Date;
}

export interface TrackAssignmentView {
  id: string;
  studentPersonId: string;
  track: StudentTrack;
  effectiveDate: string;
  reviewDate: string | null;
  confidence: number;
  actionCardId: string;
}

export interface DecideActionCardResult {
  actionCardId: string;
  status: "approved" | "edited" | "dismissed";
  trackAssignment: TrackAssignmentView | null;
  supersededTrackAssignmentId: string | null;
}

/**
 * Decide one proposed action card. approve/edit of a track_transition card retires the
 * student's active track assignment and writes the new one (effective + review dates) —
 * the ONLY path that changes a track. dismiss changes nothing but the card. Exactly one
 * event per decision, one transaction. Works on the app role inside `withTenant` or on the
 * owner (every query filters by tenant_id).
 * Throws `unknown_card`, `already_decided`, `card_expired`, `stale_card`, `unknown_decider`,
 * `not_authorized`, `unsupported_card_type`, `invalid_decision`, `invalid_payload`.
 */
export function decideActionCard(db: PrismaClient | Db, input: DecideActionCardInput): Promise<DecideActionCardResult> {
  return inTx(db, async (tx) => {
    const { tenantId, decision } = input;
    const now = input.now ?? new Date();
    if (!["approve", "edit", "dismiss"].includes(decision)) throw new ActionCardError("invalid_decision", `unknown decision "${String(decision)}"`);

    const peek = isUuid(input.actionCardId)
      ? await tx.actionCard.findFirst({ where: { tenantId, id: input.actionCardId }, select: { subjectPersonId: true } })
      : null;
    if (!peek) throw new ActionCardError("unknown_card", `action card ${input.actionCardId} not found in tenant`);
    await lockStudentTrack(tx, tenantId, peek.subjectPersonId);
    const card = (await tx.actionCard.findFirst({ where: { tenantId, id: input.actionCardId } }))!;
    if (card.status !== "proposed") throw new ActionCardError("already_decided", `action card ${card.id} is already ${card.status}`);
    if (card.expiresAt && card.expiresAt <= now) throw new ActionCardError("card_expired", `action card ${card.id} expired at ${card.expiresAt.toISOString()}`);

    const decider = isUuid(input.deciderPersonId)
      ? await tx.person.findFirst({ where: { tenantId, id: input.deciderPersonId }, select: { id: true } })
      : null;
    if (!decider) throw new ActionCardError("unknown_decider", `person ${input.deciderPersonId} not found in tenant`);
    const allowed = [card.assigneeRole, ...OVERRIDE_ROLES];
    const role = await tx.roleAssignment.findFirst({
      where: {
        tenantId,
        personId: decider.id,
        status: "active",
        role: { key: { in: allowed } },
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      select: { id: true },
    });
    if (!role) throw new ActionCardError("not_authorized", `deciding this card needs role ${allowed.join(" or ")}`);

    const note = input.note?.trim() || null;
    const decided = { decidedByPersonId: decider.id, decidedAt: now, decisionNote: note };
    const actor = { actorPersonId: decider.id, actorUserId: input.actorUserId ?? null };

    if (decision === "dismiss") {
      if (input.edits) throw new ActionCardError("invalid_decision", "dismiss takes no edits");
      await tx.actionCard.update({ where: { id: card.id }, data: { status: "dismissed", ...decided } });
      await tx.event.create({
        data: { tenantId, type: "action_card.dismissed", ...actor, subjectPersonId: card.subjectPersonId, entityType: "action_card", entityId: card.id, payload: { cardType: card.type, note } },
      });
      return { actionCardId: card.id, status: "dismissed", trackAssignment: null, supersededTrackAssignmentId: null };
    }

    if (card.type !== "track_transition")
      throw new ActionCardError("unsupported_card_type", `approving ${card.type} cards is not supported yet (dismiss is)`);

    const proposed = card.proposedPayload as unknown as TrackTransitionPayload;
    const edits = input.edits ?? {};
    if (edits.track !== undefined && !(STUDENT_TRACKS as readonly string[]).includes(edits.track))
      throw new ActionCardError("invalid_payload", `track must be one of ${STUDENT_TRACKS.join(", ")}`);
    if (decision === "approve" && edits.track !== undefined && edits.track !== proposed.track)
      throw new ActionCardError("invalid_decision", "approve cannot change the track — use edit");
    const track = edits.track ?? proposed.track;
    const effective = edits.effectiveDate !== undefined ? parseDate(edits.effectiveDate, "effectiveDate") : dateOnly(now);
    const review =
      edits.reviewDate === null
        ? null
        : edits.reviewDate !== undefined
          ? parseDate(edits.reviewDate, "reviewDate")
          : new Date(effective.getTime() + (proposed.reviewAfterDays ?? TRACK_RULES.reviewAfterDays) * DAY_MS);
    if (review && review < effective) throw new ActionCardError("invalid_payload", "reviewDate must be on or after effectiveDate");

    const current = await tx.trackAssignment.findFirst({ where: { tenantId, studentPersonId: card.subjectPersonId, status: "active" }, select: { id: true, track: true } });
    if ((current?.id ?? null) !== (proposed.currentTrackAssignmentId ?? null))
      throw new ActionCardError("stale_card", "the student's track changed after this card was proposed");
    if (current && current.track === track) throw new ActionCardError("invalid_payload", `the student is already on the ${track} track`);
    if (decision === "edit" && edits.track === undefined && edits.effectiveDate === undefined && edits.reviewDate === undefined)
      throw new ActionCardError("invalid_decision", "edit needs at least one change (track, effectiveDate or reviewDate)");

    const status = decision === "approve" ? "approved" : "edited";
    const applied = { ...proposed, track, effectiveDate: isoDate(effective), reviewDate: review ? isoDate(review) : null };
    // Order matters for the DB guard: the card must be decided before the assignment exists.
    await tx.actionCard.update({ where: { id: card.id }, data: { status, decidedPayload: applied as unknown as Prisma.InputJsonValue, ...decided } });
    if (current) await tx.trackAssignment.update({ where: { id: current.id }, data: { status: "superseded" } });
    const created = await tx.trackAssignment.create({
      data: {
        tenantId,
        studentPersonId: card.subjectPersonId,
        track,
        status: "active",
        evidenceRefs: [{ type: "action_card", id: card.id }, ...((card.evidenceRefs as Prisma.JsonArray | null) ?? [])] as Prisma.InputJsonValue,
        confidence: card.confidence,
        effectiveDate: effective,
        reviewDate: review,
        actionCardId: card.id,
      },
      select: { id: true },
    });
    await tx.event.create({
      data: {
        tenantId,
        type: `action_card.${status}`,
        ...actor,
        subjectPersonId: card.subjectPersonId,
        entityType: "action_card",
        entityId: card.id,
        payload: {
          cardType: card.type,
          track,
          proposedTrack: proposed.track,
          fromTrack: current?.track ?? null,
          trackAssignmentId: created.id,
          supersededTrackAssignmentId: current?.id ?? null,
          effectiveDate: applied.effectiveDate,
          reviewDate: applied.reviewDate,
          note,
        },
        evidenceRefs: [{ type: "track_assignment", id: created.id }],
      },
    });
    return {
      actionCardId: card.id,
      status,
      trackAssignment: {
        id: created.id,
        studentPersonId: card.subjectPersonId,
        track,
        effectiveDate: applied.effectiveDate,
        reviewDate: applied.reviewDate,
        confidence: card.confidence.toNumber(),
        actionCardId: card.id,
      },
      supersededTrackAssignmentId: current?.id ?? null,
    };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Open (proposed, unexpired) cards of a tenant, newest first. Owner or app role in withTenant. */
export function listOpenActionCards(db: PrismaClient | Db, tenantId: string, opts: { assigneeRole?: string; subjectPersonId?: string; now?: Date } = {}) {
  return db.actionCard.findMany({
    where: {
      tenantId,
      status: "proposed",
      OR: [{ expiresAt: null }, { expiresAt: { gt: opts.now ?? new Date() } }],
      ...(opts.assigneeRole ? { assigneeRole: opts.assigneeRole } : {}),
      ...(opts.subjectPersonId && isUuid(opts.subjectPersonId) ? { subjectPersonId: opts.subjectPersonId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** A student's track history (newest effective date first). */
export function getTrackHistory(db: PrismaClient | Db, tenantId: string, studentPersonId: string) {
  if (!isUuid(studentPersonId)) return Promise.resolve([]);
  return db.trackAssignment.findMany({
    where: { tenantId, studentPersonId },
    orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
  });
}
