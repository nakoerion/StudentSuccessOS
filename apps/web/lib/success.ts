/**
 * Server-side loaders for the success-engine UI. Every function takes the tenant
 * transaction from `requireTenant().db`, so RLS bounds each query to the tenant; the
 * tenantId argument is the same tenant (the services filter on it too). Results are plain,
 * serialisable view objects (dates pre-formatted in the tenant's time zone).
 */
import {
  getLatestRiskScore,
  getTrackHistory,
  listAlerts,
  listOpenActionCards,
  type AlertState,
  type RiskFactorResult,
  type TenantTx,
  type TrackTransitionPayload,
} from "@ssos/db";

import type { Viewer } from "./access";
import {
  canDecideCard,
  currentRung,
  readAcknowledgements,
  readLadder,
  slaStatus,
  type Band,
  type SlaStatus,
  type Track,
} from "./success-view";

/** Formats instants and calendar dates for one locale + tenant time zone. */
export interface DateFormatters {
  dateTime: (d: Date) => string;
  /** A DATE column (UTC midnight) shown as that calendar day. */
  day: (d: Date) => string;
}

export function makeDateFormatters(locale: string, timeZone: string): DateFormatters {
  const dt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return { dateTime: (d) => dt.format(d), day: (d) => day.format(d) };
}

/** The tenant's IANA time zone (falls back to UTC if the row is unreadable). */
export async function tenantTimeZone(tx: TenantTx, tenantId: string): Promise<string> {
  const t = await tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } });
  return t?.timezone || "UTC";
}

// ─── Action inbox ────────────────────────────────────────────────────────────

export interface EvidenceFactor {
  factor: string;
  contribution: number;
  vsBaseline: number | null;
  risk: number | null;
  baseline: number | null;
}

export interface InboxCardView {
  id: string;
  type: string;
  student: { id: string; name: string };
  assigneeRole: string;
  confidence: number;
  canDecide: boolean;
  createdAt: string;
  expiresAt: string | null;
  /** Track transition proposal (null for card types without a track). */
  proposal: { track: Track; fromTrack: Track | null; reviewAfterDays: number; defaultEffectiveDate: string; defaultReviewDate: string } | null;
  evidence: {
    score: number;
    band: Band;
    modelVersion: number;
    cohortScore: number | null;
    cohortGrade: string | null;
    coverage: number | null;
    topFactors: EvidenceFactor[];
  } | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function loadInboxCards(
  tx: TenantTx,
  input: { tenantId: string; viewer: Viewer; fmt: DateFormatters; subjectPersonId?: string; now?: Date },
): Promise<InboxCardView[]> {
  const now = input.now ?? new Date();
  const cards = await listOpenActionCards(tx, input.tenantId, { subjectPersonId: input.subjectPersonId, now });
  if (cards.length === 0) return [];
  const personIds = [...new Set(cards.map((c) => c.subjectPersonId))];
  const scoreIds = [...new Set(cards.map((c) => c.sourceRiskScoreId).filter((x): x is string => !!x))];
  const [people, scores] = await Promise.all([
    tx.person.findMany({ where: { id: { in: personIds } }, select: { id: true, displayName: true } }),
    scoreIds.length
      ? tx.riskScore.findMany({ where: { id: { in: scoreIds } }, select: { id: true, score: true, band: true, modelVersion: true, factors: true, cohortBaseline: true } })
      : Promise.resolve([]),
  ]);
  const names = new Map(people.map((p) => [p.id, p.displayName]));
  const scoreById = new Map(scores.map((s) => [s.id, s]));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return cards.map((c): InboxCardView => {
    const payload = (c.proposedPayload ?? {}) as Partial<TrackTransitionPayload>;
    const src = c.sourceRiskScoreId ? scoreById.get(c.sourceRiskScoreId) : undefined;
    const srcFactors = (src?.factors as unknown as RiskFactorResult[] | undefined) ?? [];
    const cohort = (src?.cohortBaseline ?? null) as { score?: number | null; grade?: string | null } | null;
    const top: EvidenceFactor[] = srcFactors.length
      ? srcFactors.filter((f) => f.top).map((f) => ({ factor: f.factor, contribution: f.contribution, vsBaseline: f.vsBaseline, risk: f.risk, baseline: f.baseline }))
      : (payload.topFactors ?? []).map((f) => ({ factor: f.factor, contribution: f.contribution, vsBaseline: f.vsBaseline, risk: null, baseline: null }));
    const score = src ? src.score.toNumber() : payload.score;
    const band = (src?.band ?? payload.band) as Band | undefined;
    const reviewAfter = payload.reviewAfterDays ?? 42;
    const isTrack = c.type === "track_transition" && !!payload.track;
    return {
      id: c.id,
      type: c.type,
      student: { id: c.subjectPersonId, name: names.get(c.subjectPersonId) ?? "—" },
      assigneeRole: c.assigneeRole,
      confidence: c.confidence.toNumber(),
      canDecide: canDecideCard(input.viewer.roles, c.assigneeRole),
      createdAt: input.fmt.dateTime(c.createdAt),
      expiresAt: c.expiresAt ? input.fmt.dateTime(c.expiresAt) : null,
      proposal: isTrack
        ? {
            track: payload.track as Track,
            fromTrack: (payload.fromTrack ?? null) as Track | null,
            reviewAfterDays: reviewAfter,
            defaultEffectiveDate: isoDay(today),
            defaultReviewDate: isoDay(new Date(today.getTime() + reviewAfter * 86_400_000)),
          }
        : null,
      evidence:
        score !== undefined && band
          ? {
              score,
              band,
              modelVersion: src?.modelVersion ?? payload.modelVersion ?? 0,
              cohortScore: cohort?.score ?? null,
              cohortGrade: cohort?.grade ?? null,
              coverage: payload.basis?.coverage ?? null,
              topFactors: top,
            }
          : null,
    };
  });
}

// ─── Student profile ─────────────────────────────────────────────────────────

export interface StudentHeader {
  id: string;
  name: string;
  externalRef: string | null;
  units: string[];
}

/** The person if they hold an active student role in the tenant, else null. */
export async function loadStudentHeader(tx: TenantTx, studentPersonId: string): Promise<StudentHeader | null> {
  if (!/^[0-9a-f-]{36}$/i.test(studentPersonId)) return null;
  const p = await tx.person.findFirst({
    where: { id: studentPersonId, roleAssignments: { some: { status: "active", role: { key: "student" } } } },
    select: {
      id: true,
      displayName: true,
      externalRef: true,
      roleAssignments: { where: { status: "active", role: { key: "student" } }, select: { tenantUnit: { select: { name: true } } } },
    },
  });
  if (!p) return null;
  const units = p.roleAssignments.map((r) => r.tenantUnit?.name).filter((n): n is string => !!n);
  return { id: p.id, name: p.displayName, externalRef: p.externalRef, units: [...new Set(units)] };
}

export interface RiskPanelView {
  score: number;
  band: Band;
  modelVersion: number;
  computedAt: string;
  cohort: { grade: string | null; size: number; scored: number; score: number | null };
  factors: RiskFactorResult[];
}

export async function loadRiskPanel(tx: TenantTx, tenantId: string, studentPersonId: string, fmt: DateFormatters): Promise<RiskPanelView | null> {
  const s = await getLatestRiskScore(tx, tenantId, studentPersonId);
  if (!s) return null;
  return {
    score: s.score,
    band: s.band as Band,
    modelVersion: s.modelVersion,
    computedAt: fmt.dateTime(s.computedAt),
    cohort: { grade: s.cohortBaseline?.grade ?? null, size: s.cohortBaseline?.cohortSize ?? 0, scored: s.cohortBaseline?.scoredCohortSize ?? 0, score: s.cohortBaseline?.score ?? null },
    factors: s.factors,
  };
}

export interface TrackHistoryRow {
  id: string;
  track: Track;
  status: string;
  effectiveDate: string;
  reviewDate: string | null;
  confidence: number;
  decision: { status: string; by: string | null; at: string | null; note: string | null } | null;
}

export async function loadTrackHistory(tx: TenantTx, tenantId: string, studentPersonId: string, fmt: DateFormatters): Promise<TrackHistoryRow[]> {
  const rows = await getTrackHistory(tx, tenantId, studentPersonId);
  const cardIds = rows.map((r) => r.actionCardId).filter((x): x is string => !!x);
  const cards = cardIds.length
    ? await tx.actionCard.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, status: true, decidedAt: true, decisionNote: true, decidedBy: { select: { displayName: true } } },
      })
    : [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = r.actionCardId ? byId.get(r.actionCardId) : undefined;
    return {
      id: r.id,
      track: r.track as Track,
      status: r.status,
      effectiveDate: fmt.day(r.effectiveDate),
      reviewDate: r.reviewDate ? fmt.day(r.reviewDate) : null,
      confidence: r.confidence.toNumber(),
      decision: c ? { status: c.status, by: c.decidedBy?.displayName ?? null, at: c.decidedAt ? fmt.dateTime(c.decidedAt) : null, note: c.decisionNote } : null,
    };
  });
}

export interface AlertRow {
  id: string;
  ruleKey: string;
  ruleName: string;
  severity: string;
  state: AlertState;
  rung: { rung: number; of: number; role: string };
  dueAt: string | null;
  sla: SlaStatus;
  triggeredAt: string;
  acknowledgements: { by: string; role: string; at: string; note: string | null }[];
}

const ALL_ALERT_STATES: AlertState[] = ["open", "escalated", "acknowledged", "resolved", "dismissed"];

export async function loadStudentAlerts(tx: TenantTx, tenantId: string, studentPersonId: string, fmt: DateFormatters, now = new Date()): Promise<AlertRow[]> {
  const alerts = await listAlerts(tx, tenantId, { studentPersonId, states: ALL_ALERT_STATES });
  if (alerts.length === 0) return [];
  const ruleIds = [...new Set(alerts.map((a) => a.ruleId))];
  const rules = await tx.alertRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, escalation: true } });
  const ladders = new Map(rules.map((r) => [r.id, readLadder(r.escalation)]));
  const acks = alerts.map((a) => readAcknowledgements(a.acknowledgements));
  const ackPeople = [...new Set(acks.flat().map((a) => a.personId))];
  const people = ackPeople.length ? await tx.person.findMany({ where: { id: { in: ackPeople } }, select: { id: true, displayName: true } }) : [];
  const names = new Map(people.map((p) => [p.id, p.displayName]));
  const unresolved = (s: AlertState) => s === "open" || s === "escalated" || s === "acknowledged";
  const rows = alerts.map(
    (a, i): AlertRow => ({
      id: a.id,
      ruleKey: a.rule.key,
      ruleName: a.rule.name,
      severity: a.severity,
      state: a.state,
      rung: currentRung(ladders.get(a.ruleId) ?? [], a.escalationLevel, a.assigneeRole),
      dueAt: a.dueAt ? fmt.dateTime(a.dueAt) : null,
      sla: unresolved(a.state) ? slaStatus(a.dueAt, now) : { kind: "none" },
      triggeredAt: fmt.dateTime(a.triggeredAt),
      acknowledgements: acks[i]!.map((k) => ({ by: names.get(k.personId) ?? "—", role: k.role, at: fmt.dateTime(new Date(k.at)), note: k.note ?? null })),
    }),
  );
  // Unresolved first (service order inside each group: most urgent due time first).
  return [...rows.filter((r) => unresolved(r.state)), ...rows.filter((r) => !unresolved(r.state))];
}
