"use client";

/**
 * ActionInbox — the advisor's triage surface for proposed action cards (success engine).
 *
 * Every decision happens on the card: Approve, Edit (track, review date, note) and Dismiss
 * (a reason from a short list plus an optional note), singly or in bulk for cards proposing
 * the same track. A decision is held for an undo window (UNDO_MS) and only then sent to
 * `decideCardAction`; Undo inside the window simply never sends it, so an undo can never
 * re-apply something the database refused. If the database refuses on commit, the card
 * comes back with the reason and with everything the person typed still in the form.
 *
 * Nothing is applied automatically: a card only changes a track once a person decides it.
 * Logical properties only (ms/me, start/end, text-start) so the layout mirrors in RTL.
 */
import { Badge, Button, Card, cn, Input, Label } from "@ssos/ui";
import { ArrowRight, Check, CheckCheck, ChevronDown, Keyboard, Pencil, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { decideCardAction } from "../app/t/[tenantSlug]/success-actions";
import type { InboxCardView } from "../lib/success";
import { BAND_VARIANT, barPercent, confidenceLevel, type DecisionErrorCode, type Track, TRACK_VARIANT, TRACKS } from "../lib/success-view";

/** How long a decision can be undone before it is sent. */
export const UNDO_MS = 8000;
export const DISMISS_REASONS = ["already_supported", "data_incorrect", "not_now", "other"] as const;
type DismissReason = (typeof DISMISS_REASONS)[number];

type Mode = "edit" | "dismiss";
type Outcome = "approved" | "edited" | "dismissed";

/** What the person typed on a card; kept outside the card so an error never loses it. */
interface Draft {
  track?: Track;
  reviewDate?: string;
  note?: string;
  reason?: DismissReason;
}

interface Planned {
  cardId: string;
  student: string;
  outcome: Outcome;
  track: Track | null;
  fields: Record<string, string>;
}

interface Batch {
  key: number;
  items: Planned[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface DecidedLog {
  id: string;
  student: string;
  outcome: Outcome;
  track: string | null;
}

export interface ActionInboxProps {
  tenantSlug: string;
  cards: InboxCardView[];
  /** Link each card to the student profile (off on the profile itself). */
  showStudentLink?: boolean;
  emptyLabel?: string;
  /** j/k/a/e/d/x keyboard shortcuts (the inbox page; off where the list is embedded). */
  keyboard?: boolean;
}

export function ActionInbox({ tenantSlug, cards, showStudentLink = true, emptyLabel, keyboard = false }: ActionInboxProps) {
  const t = useTranslations("success");
  const format = useFormatter();

  // Everything seen this session counts toward "N of M decided", even after the server
  // drops decided cards from the list on revalidation.
  const seen = useRef(new Set<string>());
  for (const c of cards) seen.current.add(c.id);
  const [committed, setCommitted] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<Batch[]>([]);
  const [errors, setErrors] = useState<Record<string, DecisionErrorCode>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [panel, setPanel] = useState<{ id: string; mode: Mode } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [failedToast, setFailedToast] = useState<number>(0);
  const [log, setLog] = useState<DecidedLog[]>([]);
  const [help, setHelp] = useState(false);
  const batchKey = useRef(0);
  const batchesRef = useRef<Batch[]>([]);
  batchesRef.current = batches;

  const pendingIds = useMemo(() => new Set(batches.flatMap((b) => b.items.map((i) => i.cardId))), [batches]);
  const visible = cards.filter((c) => !committed.has(c.id) && !pendingIds.has(c.id));
  const total = seen.current.size;
  const decided = Math.min(total, committed.size + pendingIds.size);

  const setDraft = useCallback((id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } })), []);

  // ---- commit / undo ----------------------------------------------------------------
  const commit = useCallback(
    async (key: number) => {
      const batch = batchesRef.current.find((b) => b.key === key);
      if (!batch) return;
      clearTimeout(batch.timer);
      batchesRef.current = batchesRef.current.filter((b) => b.key !== key);
      setBatches((bs) => bs.filter((b) => b.key !== key));
      let failed = 0;
      for (const item of batch.items) {
        const fd = new FormData();
        fd.set("tenantSlug", tenantSlug);
        fd.set("actionCardId", item.cardId);
        for (const [k, v] of Object.entries(item.fields)) fd.set(k, v);
        let result: Awaited<ReturnType<typeof decideCardAction>>;
        try {
          result = await decideCardAction({ status: "idle" }, fd);
        } catch {
          result = { status: "error", code: "unexpected" };
        }
        if (result.status === "ok") {
          setCommitted((s) => new Set(s).add(item.cardId));
          setLog((l) => [{ id: item.cardId, student: item.student, outcome: result.outcome, track: result.track }, ...l].slice(0, 5));
          setDrafts((d) => {
            const next = { ...d };
            delete next[item.cardId];
            return next;
          });
        } else if (result.status === "error") {
          // Rollback: the card returns with the reason; its draft (note, track, date) is kept.
          failed++;
          setErrors((e) => ({ ...e, [item.cardId]: result.code }));
        }
      }
      if (failed > 0) setFailedToast(failed);
    },
    [tenantSlug],
  );

  const schedule = useCallback(
    (items: Planned[]) => {
      if (items.length === 0) return;
      const key = ++batchKey.current;
      const timer = setTimeout(() => void commit(key), UNDO_MS);
      const batch = { key, items, startedAt: Date.now(), timer };
      batchesRef.current = [...batchesRef.current, batch];
      setBatches((bs) => [...bs, batch]);
      setErrors((e) => {
        const next = { ...e };
        for (const i of items) delete next[i.cardId];
        return next;
      });
      setSelected(new Set());
      setPanel(null);
      setFailedToast(0);
    },
    [commit],
  );

  const undo = (key: number) => {
    const batch = batchesRef.current.find((b) => b.key === key);
    if (!batch) return;
    clearTimeout(batch.timer);
    batchesRef.current = batchesRef.current.filter((b) => b.key !== key);
    setBatches((bs) => bs.filter((b) => b.key !== key));
    setFocusId(batch.items[0]?.cardId ?? null);
  };

  // Leaving the page or hiding the tab sends what is still waiting, rather than losing it.
  useEffect(() => {
    const flush = () => {
      for (const b of batchesRef.current) void commit(b.key);
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commit]);

  // ---- planning a decision ------------------------------------------------------------
  const planApprove = (c: InboxCardView): Planned | null =>
    c.canDecide && c.proposal
      ? { cardId: c.id, student: c.student.name, outcome: "approved", track: c.proposal.track, fields: { decision: "approve", ...(drafts[c.id]?.note ? { note: drafts[c.id]!.note! } : {}) } }
      : null;

  const planEdit = (c: InboxCardView): Planned | null => {
    if (!c.canDecide || !c.proposal) return null;
    const d = drafts[c.id] ?? {};
    const track = d.track ?? c.proposal.track;
    const review = d.reviewDate ?? c.proposal.defaultReviewDate;
    const note: Record<string, string> = d.note?.trim() ? { note: d.note.trim() } : {};
    // Unchanged fields: this is an approval with a note (the service refuses an empty edit).
    if (track === c.proposal.track && review === c.proposal.defaultReviewDate) {
      return { cardId: c.id, student: c.student.name, outcome: "approved", track, fields: { decision: "approve", ...note } };
    }
    return {
      cardId: c.id,
      student: c.student.name,
      outcome: "edited",
      track,
      fields: {
        decision: "edit",
        ...(track !== c.proposal.track ? { track } : {}),
        ...(review !== c.proposal.defaultReviewDate ? (review ? { reviewDate: review } : { clearReview: "1" }) : {}),
        ...note,
      },
    };
  };

  const planDismiss = (c: InboxCardView, reasonLabel: string): Planned | null => {
    if (!c.canDecide) return null;
    const detail = drafts[c.id]?.note?.trim();
    return { cardId: c.id, student: c.student.name, outcome: "dismissed", track: null, fields: { decision: "dismiss", note: detail ? `${reasonLabel}: ${detail}` : reasonLabel } };
  };

  const approveCard = (c: InboxCardView) => {
    const p = planApprove(c);
    if (p) schedule([p]);
  };
  const openPanel = (c: InboxCardView, mode: Mode) => {
    if (!c.canDecide || (mode === "edit" && !c.proposal)) return;
    setFocusId(c.id);
    setPanel({ id: c.id, mode });
  };

  // ---- selection (bulk) -----------------------------------------------------------------
  const selectedCards = visible.filter((c) => selected.has(c.id));
  const bulkTrack = selectedCards[0]?.proposal?.track ?? null;
  const selectable = (c: InboxCardView) => c.canDecide && !!c.proposal && (bulkTrack === null || c.proposal.track === bulkTrack);
  const toggleSelect = (c: InboxCardView) => {
    if (!selectable(c) && !selected.has(c.id)) return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(c.id)) n.delete(c.id);
      else n.add(c.id);
      return n;
    });
  };

  // ---- keyboard ---------------------------------------------------------------------------
  const listRef = useRef<HTMLUListElement>(null);
  const focusIdx = Math.max(0, visible.findIndex((c) => c.id === focusId));
  const focused = visible[focusIdx] ?? null;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-card-id="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusId]);

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (e.key === "Escape") {
        if (panel) setPanel(null);
        else if (help) setHelp(false);
        else setSelected(new Set());
        return;
      }
      if (typing) return;
      const list = visibleRef.current;
      const idx = Math.max(0, list.findIndex((c) => c.id === focusId));
      const cur = list[idx];
      switch (e.key) {
        case "j":
          setFocusId(list[Math.min(list.length - 1, idx + (focusId ? 1 : 0))]?.id ?? null);
          break;
        case "k":
          setFocusId(list[Math.max(0, idx - 1)]?.id ?? null);
          break;
        case "a":
          if (cur) approveCard(cur);
          break;
        case "e":
          if (cur) openPanel(cur, "edit");
          break;
        case "d":
          if (cur) openPanel(cur, "dismiss");
          break;
        case "x":
          if (cur) toggleSelect(cur);
          break;
        case "o":
        case "Enter":
          if (cur && target === document.body) toggleExpand(cur.id);
          else return;
          break;
        case "?":
          setHelp((h) => !h);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const showProgress = total > 0;
  const allDone = visible.length === 0;

  return (
    <section className="flex flex-col gap-4" data-testid="action-inbox" aria-label={t("inbox.title")}>
      {showProgress ? (
        <div className="flex flex-col gap-2" data-testid="inbox-progress">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium" data-testid="inbox-count" data-decided={decided} data-total={total}>
              {t("inbox.progress", { decided: format.number(decided), total: format.number(total) })}
            </p>
            {keyboard ? <ShortcutHelp open={help} onOpenChange={setHelp} /> : null}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={decided} aria-label={t("inbox.progressLabel")}>
            <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${total ? (decided / total) * 100 : 0}%` }} />
          </div>
        </div>
      ) : null}

      {/* Committed decisions, for screen readers and as a short session log. */}
      <div role="status" aria-live="polite" className="sr-only">
        {log.map((d) => (
          <p key={d.id} data-testid="inbox-decided" data-outcome={d.outcome}>
            {d.outcome === "dismissed"
              ? t("inbox.decidedDismissed", { student: d.student })
              : t("inbox.decidedTrack", { student: d.student, outcome: d.outcome, track: d.track ? t(`tracks.${d.track}`) : "—" })}
          </p>
        ))}
      </div>

      {selectedCards.length > 0 && bulkTrack ? (
        <BulkBar cards={selectedCards} track={bulkTrack} onCancel={() => setSelected(new Set())} onConfirm={(review) => schedule(selectedCards.flatMap((c) => {
          if (!review || review === c.proposal?.defaultReviewDate) return planApprove(c) ?? [];
          return { cardId: c.id, student: c.student.name, outcome: "edited" as const, track: bulkTrack, fields: { decision: "edit", reviewDate: review } };
        }))} />
      ) : null}

      {allDone ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="inbox-empty">
          <span className="flex size-12 items-center justify-center rounded-full bg-success-subtle text-success-foreground">
            <CheckCheck className="size-6" aria-hidden />
          </span>
          {emptyLabel && total === 0 ? (
            <p className="text-muted-foreground">{emptyLabel}</p>
          ) : (
            <>
              <p className="text-lg font-semibold">{t("inbox.caughtUp.title")}</p>
              <p className="max-w-md text-sm text-muted-foreground">{t("inbox.caughtUp.body")}</p>
            </>
          )}
        </Card>
      ) : (
        <ul ref={listRef} className="flex flex-col gap-3" data-testid="inbox-list">
          {visible.map((c) => (
            <li key={c.id}>
              <ActionCardItem
                card={c}
                tenantSlug={tenantSlug}
                showStudentLink={showStudentLink}
                focused={keyboard && focused?.id === c.id && focusId !== null}
                expanded={expanded.has(c.id)}
                onToggleExpand={() => toggleExpand(c.id)}
                selected={selected.has(c.id)}
                selectable={selectable(c)}
                onToggleSelect={() => toggleSelect(c)}
                mode={panel?.id === c.id ? panel.mode : null}
                onMode={(m) => (m ? openPanel(c, m) : setPanel(null))}
                draft={drafts[c.id] ?? {}}
                onDraft={(patch) => setDraft(c.id, patch)}
                error={errors[c.id] ?? null}
                onApprove={() => approveCard(c)}
                onEdit={() => {
                  const p = planEdit(c);
                  if (p) schedule([p]);
                }}
                onDismiss={(label) => {
                  const p = planDismiss(c, label);
                  if (p) schedule([p]);
                }}
                onFocus={() => setFocusId(c.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <Toasts batches={batches} failed={failedToast} onUndo={undo} onCommitNow={(k) => void commit(k)} onCloseFailed={() => setFailedToast(0)} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------

function ActionCardItem(props: {
  card: InboxCardView;
  tenantSlug: string;
  showStudentLink: boolean;
  focused: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  selected: boolean;
  selectable: boolean;
  onToggleSelect: () => void;
  mode: Mode | null;
  onMode: (m: Mode | null) => void;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  error: DecisionErrorCode | null;
  onApprove: () => void;
  onEdit: () => void;
  onDismiss: (reasonLabel: string) => void;
  onFocus: () => void;
}) {
  const { card, tenantSlug, showStudentLink, focused, expanded, mode, draft, error } = props;
  const t = useTranslations("success");
  const tRoles = useTranslations("roles");
  const format = useFormatter();
  const formId = useId();

  const pct = (n: number) => format.number(n, { style: "percent", maximumFractionDigits: 0 });
  const pts = (n: number) => format.number(n, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const signed = (n: number) => format.number(n, { maximumFractionDigits: 2, signDisplay: "exceptZero" });
  const level = confidenceLevel(card.confidence);
  const ev = card.evidence;
  const maxVs = ev ? Math.max(1, ...ev.topFactors.map((f) => Math.abs(f.vsBaseline ?? f.contribution))) : 1;
  const role = tRoles.has(card.assigneeRole) ? tRoles(card.assigneeRole) : card.assigneeRole;
  const panelId = `${formId}-evidence`;

  return (
    <Card
      data-testid="action-card"
      data-card-id={card.id}
      data-student-id={card.student.id}
      data-focused={focused || undefined}
      onClick={props.onFocus}
      className={cn(
        "group overflow-hidden transition-shadow duration-150",
        focused && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        props.selected && "border-brand",
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {card.canDecide && card.proposal ? (
            <input
              type="checkbox"
              checked={props.selected}
              disabled={!props.selectable && !props.selected}
              onChange={props.onToggleSelect}
              aria-label={t("inbox.bulk.select", { student: card.student.name })}
              title={`${t("inbox.bulk.selectHint")} (x)`}
              className="mt-1 size-4 shrink-0 accent-[var(--brand)] disabled:opacity-40"
              data-testid="card-select"
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-base font-semibold">
                {showStudentLink ? (
                  <Link href={`/t/${tenantSlug}/students/${card.student.id}`} className="rounded-sm hover:underline" data-testid="card-student-link">
                    {card.student.name}
                  </Link>
                ) : (
                  card.student.name
                )}
              </h3>
              <span className="text-xs text-muted-foreground">{t(`cardTypes.${card.type}`)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              {card.proposal ? (
                <span className="flex items-center gap-1.5" data-testid="card-proposal">
                  <Badge variant="neutral">{card.proposal.fromTrack ? t(`tracks.${card.proposal.fromTrack}`) : t("inbox.noTrack")}</Badge>
                  <ArrowRight className="size-3.5 text-muted-foreground rtl:rotate-180" aria-label={t("inbox.to")} />
                  <Badge variant={TRACK_VARIANT[card.proposal.track]} data-testid="card-proposed-track" data-track={card.proposal.track}>
                    {t(`tracks.${card.proposal.track}`)}
                  </Badge>
                </span>
              ) : null}
              {ev ? (
                <span className="flex items-center gap-1.5 ps-1" data-testid="evidence-summary">
                  <span className="text-muted-foreground">{t("risk.score")}</span>
                  <span className="font-semibold tabular-nums" data-testid="evidence-score">
                    {pts(ev.score)}
                  </span>
                  <Badge variant={BAND_VARIANT[ev.band]} data-testid="evidence-band" data-band={ev.band}>
                    {t(`bands.${ev.band}`)}
                  </Badge>
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1" data-testid="card-confidence" data-level={level}>
          <span className="text-xs text-muted-foreground">{t("inbox.confidence")}</span>
          <span className="flex items-center gap-2">
            <span className="font-semibold tabular-nums">{pct(card.confidence)}</span>
            <Badge variant={level === "high" ? "success" : level === "medium" ? "neutral" : "warn"}>{t(`confidence.${level}`)}</Badge>
          </span>
        </div>
      </div>

      {expanded ? (
        <div id={panelId} className="border-t border-border bg-muted/30 px-4 py-3" data-testid="evidence-panel">
          {ev ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                {ev.cohortScore !== null ? (
                  <span data-testid="evidence-cohort">
                    {t("risk.cohortMean", { score: pts(ev.cohortScore), grade: ev.cohortGrade ?? "—" })}
                    {" · "}
                    <span className="font-medium tabular-nums">{t("risk.vsCohort", { points: signed(ev.score - ev.cohortScore) })}</span>
                  </span>
                ) : null}
                {ev.coverage !== null ? <span className="text-muted-foreground">{t("inbox.coverage", { pct: pct(ev.coverage) })}</span> : null}
              </div>
              <p className="mt-3 text-xs font-medium text-muted-foreground">{t("inbox.topFactors")}</p>
              <ol className="mt-1 flex flex-col gap-1.5" data-testid="evidence-factors">
                {ev.topFactors.map((f) => {
                  const vs = f.vsBaseline ?? f.contribution;
                  return (
                    <li key={f.factor} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm" data-testid="evidence-factor" data-factor={f.factor}>
                      <span className="truncate">{t(`factors.${f.factor}`)}</span>
                      <span className="flex h-2 items-center" aria-hidden>
                        <span className={cn("block h-2 rounded-full", vs >= 0 ? "bg-danger/70" : "bg-success/70")} style={{ width: `${barPercent(vs, maxVs)}%` }} />
                      </span>
                      <span className="whitespace-nowrap text-end tabular-nums text-muted-foreground">
                        {t("inbox.factorPoints", { points: pts(f.contribution) })}
                        {f.vsBaseline !== null ? <> · {t("risk.vsCohort", { points: signed(f.vsBaseline) })}</> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("inbox.noEvidence")}</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {t("inbox.meta", { role, created: card.createdAt })}
            {card.expiresAt ? <> · {t("inbox.expires", { at: card.expiresAt })}</> : null}
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mx-4 mb-3 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-foreground" data-testid="card-error" data-code={error}>
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {card.canDecide && mode === "edit" && card.proposal ? (
        <form
          className="mx-4 mb-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
          data-testid="edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onEdit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-track`}>{t("inbox.edit.track")}</Label>
            <select
              id={`${formId}-track`}
              value={draft.track ?? card.proposal.track}
              onChange={(e) => props.onDraft({ track: e.target.value as Track })}
              className="h-9 rounded-md border border-input bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              data-testid="edit-track"
              autoFocus
            >
              {TRACKS.map((tr) => (
                <option key={tr} value={tr}>
                  {t(`tracks.${tr}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-rev`}>{t("inbox.edit.reviewDate")}</Label>
            <Input
              id={`${formId}-rev`}
              type="date"
              value={draft.reviewDate ?? card.proposal.defaultReviewDate}
              onChange={(e) => props.onDraft({ reviewDate: e.target.value })}
              dir="ltr"
              data-testid="edit-review"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-note`}>{t("inbox.note")}</Label>
            <Input id={`${formId}-note`} value={draft.note ?? ""} onChange={(e) => props.onDraft({ note: e.target.value })} maxLength={900} data-testid="edit-note" />
          </div>
          <div className="flex gap-2 sm:col-span-3">
            <Button type="submit" data-testid="edit-submit">
              <Check aria-hidden />
              {t("inbox.edit.submit")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => props.onMode(null)}>
              {t("inbox.cancel")}
              <Kbd>esc</Kbd>
            </Button>
          </div>
        </form>
      ) : null}

      {card.canDecide && mode === "dismiss" ? (
        <form
          className="mx-4 mb-3 flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
          data-testid="dismiss-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.reason) props.onDismiss(t(`inbox.dismissReasons.${draft.reason}`));
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("inbox.dismissReason")}</legend>
            <div className="flex flex-wrap gap-2">
              {DISMISS_REASONS.map((r, i) => (
                <label
                  key={r}
                  className={cn(
                    "cursor-pointer rounded-full border border-border px-3 py-1 text-sm transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    draft.reason === r ? "border-brand bg-brand-subtle text-brand-subtle-foreground" : "hover:bg-muted",
                  )}
                >
                  <input type="radio" name={`${formId}-reason`} value={r} checked={draft.reason === r} onChange={() => props.onDraft({ reason: r })} className="sr-only" autoFocus={i === 0} data-testid={`dismiss-reason-${r}`} />
                  {t(`inbox.dismissReasons.${r}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-dnote`}>{t("inbox.note")}</Label>
            <Input id={`${formId}-dnote`} value={draft.note ?? ""} onChange={(e) => props.onDraft({ note: e.target.value })} maxLength={800} data-testid="dismiss-note" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={!draft.reason} data-testid="dismiss-submit">
              {t("inbox.dismissConfirm")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => props.onMode(null)}>
              {t("inbox.cancel")}
              <Kbd>esc</Kbd>
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        {card.canDecide ? (
          mode === null ? (
            <>
              {card.proposal ? (
                <Button type="button" size="sm" onClick={props.onApprove} data-testid="card-approve" title={`${t("inbox.approve")} (a)`}>
                  <Check aria-hidden />
                  {t("inbox.approve")}
                  <Kbd onBrand>a</Kbd>
                </Button>
              ) : null}
              {card.proposal ? (
                <Button type="button" size="sm" variant="outline" onClick={() => props.onMode("edit")} data-testid="card-edit" title={`${t("inbox.edit.open")} (e)`}>
                  <Pencil aria-hidden />
                  {t("inbox.edit.open")}
                  <Kbd>e</Kbd>
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={() => props.onMode("dismiss")} data-testid="card-dismiss" title={`${t("inbox.dismiss")} (d)`}>
                <X aria-hidden />
                {t("inbox.dismiss")}
                <Kbd>d</Kbd>
              </Button>
            </>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="card-readonly">
            {t("inbox.readOnly", { role })}
          </p>
        )}
        <button
          type="button"
          onClick={props.onToggleExpand}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="ms-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          data-testid="card-expand"
        >
          {expanded ? t("inbox.hideEvidence") : t("inbox.showEvidence")}
          <ChevronDown className={cn("size-4 transition-transform duration-150", expanded && "rotate-180")} aria-hidden />
        </button>
      </div>
    </Card>
  );
}

/** Keyboard hint: only shown on hover/focus of devices with a fine pointer (not phones). */
function Kbd({ children, onBrand = false }: { children: string; onBrand?: boolean }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "hidden rounded border px-1 font-mono text-[10px] leading-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:fine)]:inline",
        onBrand ? "border-brand-foreground/40 text-brand-foreground" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </kbd>
  );
}

function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("success.inbox.shortcuts");
  const rows: [string, string][] = [
    ["j / k", t("move")],
    ["a", t("approve")],
    ["e", t("edit")],
    ["d", t("dismiss")],
    ["x", t("select")],
    ["o", t("expand")],
    ["esc", t("close")],
    ["?", t("help")],
  ];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        data-testid="shortcut-help"
      >
        <Keyboard className="size-3.5" aria-hidden />
        {t("title")}
        <kbd className="font-mono">?</kbd>
      </button>
      {open ? (
        <div role="dialog" aria-label={t("title")} className="absolute end-0 top-full z-20 mt-2 w-64 rounded-lg border border-border bg-surface p-3 shadow-lg" data-testid="shortcut-popover">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            {rows.map(([k, label]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs" dir="ltr">
                    {k}
                  </kbd>
                </dt>
                <dd className="text-muted-foreground">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function BulkBar({ cards, track, onCancel, onConfirm }: { cards: InboxCardView[]; track: Track; onCancel: () => void; onConfirm: (reviewDate: string | null) => void }) {
  const t = useTranslations("success");
  const format = useFormatter();
  const id = useId();
  const [review, setReview] = useState("");
  const [confirming, setConfirming] = useState(false);
  const trackLabel = t(`tracks.${track}`);
  const reviewLabel = review ? format.dateTime(new Date(`${review}T00:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) : null;
  const statement = reviewLabel
    ? t("inbox.bulk.statementReview", { count: cards.length, track: trackLabel, date: reviewLabel })
    : t("inbox.bulk.statement", { count: cards.length, track: trackLabel });
  return (
    <div className="sticky top-16 z-10 flex flex-col gap-3 rounded-lg border border-brand bg-brand-subtle p-3 text-brand-subtle-foreground shadow-sm sm:flex-row sm:items-end" data-testid="bulk-bar">
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-sm font-medium">{t("inbox.bulk.selected", { count: cards.length, track: trackLabel })}</p>
        {confirming ? <p className="text-sm" data-testid="bulk-statement">{statement}</p> : null}
      </div>
      {confirming ? (
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => onConfirm(review || null)} data-testid="bulk-confirm">
            <Check aria-hidden />
            {t("inbox.bulk.confirm")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            {t("inbox.cancel")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-rev`} className="text-xs">
              {t("inbox.bulk.reviewDate")}
            </Label>
            <Input id={`${id}-rev`} type="date" value={review} onChange={(e) => setReview(e.target.value)} dir="ltr" className="h-8 bg-surface" data-testid="bulk-review" />
          </div>
          <Button type="button" size="sm" onClick={() => setConfirming(true)} data-testid="bulk-decide">
            {t("inbox.bulk.decide", { count: cards.length })}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t("inbox.bulk.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Toasts({ batches, failed, onUndo, onCommitNow, onCloseFailed }: { batches: Batch[]; failed: number; onUndo: (key: number) => void; onCommitNow: (key: number) => void; onCloseFailed: () => void }) {
  const t = useTranslations("success");
  const shown = batches.slice(-3);
  if (shown.length === 0 && failed === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {failed > 0 ? (
        <div role="alert" className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm shadow-lg" data-testid="toast-failed">
          <span className="flex-1">{t("inbox.toast.failed", { count: failed })}</span>
          <button type="button" onClick={onCloseFailed} aria-label={t("inbox.cancel")} className="rounded p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}
      {shown.map((b) => {
        const first = b.items[0]!;
        const msg =
          b.items.length > 1
            ? t("inbox.toast.bulk", { count: b.items.length, track: first.track ? t(`tracks.${first.track}`) : "—" })
            : first.outcome === "dismissed"
              ? t("inbox.toast.dismissed", { student: first.student })
              : t("inbox.toast.track", { student: first.student, outcome: first.outcome, track: first.track ? t(`tracks.${first.track}`) : "—" });
        return (
          <div key={b.key} className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-border bg-foreground text-background shadow-lg" data-testid="undo-toast" data-outcome={first.outcome}>
            <div className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1">{msg}</span>
              <button
                type="button"
                onClick={() => onUndo(b.key)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-background underline-offset-2 transition-colors duration-150 hover:bg-background/15"
                data-testid="toast-undo"
              >
                <Undo2 className="size-4 rtl:-scale-x-100" aria-hidden />
                {t("inbox.toast.undo")}
              </button>
              <button type="button" onClick={() => onCommitNow(b.key)} aria-label={t("inbox.toast.saveNow")} title={t("inbox.toast.saveNow")} className="rounded p-1 opacity-70 hover:bg-background/15 hover:opacity-100" data-testid="toast-save-now">
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="h-0.5 bg-background/20">
              <div className="ssos-countdown h-full bg-background/70" style={{ "--ssos-countdown": `${UNDO_MS}ms` } as CSSProperties} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
