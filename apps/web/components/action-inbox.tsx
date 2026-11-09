"use client";

/**
 * ActionInbox — reusable list of proposed action cards (success engine). Each card shows
 * its evidence (risk score, band, top factors against the grade-cohort baseline), the
 * engine's confidence, and approve / edit / dismiss, which post to `decideCardAction`.
 * Nothing is applied automatically: a card only changes a track once a human decides it.
 *
 * Logical properties only (ms/me, start/end, text-start) so the layout mirrors in RTL.
 */
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, cn, Input, Label } from "@ssos/ui";
import { ArrowRight, Check, Inbox, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";

import { decideCardAction, type DecisionState } from "../app/t/[tenantSlug]/success-actions";
import type { InboxCardView } from "../lib/success";
import { BAND_VARIANT, barPercent, confidenceLevel, TRACK_VARIANT, TRACKS } from "../lib/success-view";

interface Decided {
  id: string;
  student: string;
  outcome: "approved" | "edited" | "dismissed";
  track: string | null;
}

export interface ActionInboxProps {
  tenantSlug: string;
  cards: InboxCardView[];
  /** Link each card to the student profile (off on the profile itself). */
  showStudentLink?: boolean;
  emptyLabel?: string;
}

export function ActionInbox({ tenantSlug, cards, showStudentLink = true, emptyLabel }: ActionInboxProps) {
  const t = useTranslations("success");
  const [decided, setDecided] = useState<Decided[]>([]);
  return (
    <section className="flex flex-col gap-4" data-testid="action-inbox" aria-label={t("inbox.title")}>
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {decided.map((d) => (
          <p key={d.id} className="rounded-md border border-border bg-muted px-3 py-2 text-sm" data-testid="inbox-decided" data-outcome={d.outcome}>
            {d.outcome === "dismissed"
              ? t("inbox.decidedDismissed", { student: d.student })
              : t("inbox.decidedTrack", { student: d.student, outcome: d.outcome, track: d.track ? t(`tracks.${d.track}`) : "—" })}
          </p>
        ))}
      </div>
      {cards.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground" data-testid="inbox-empty">
          <Inbox className="size-6" aria-hidden />
          <p>{emptyLabel ?? t("inbox.empty")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="inbox-list">
          {cards.map((c) => (
            <li key={c.id}>
              <ActionCardItem card={c} tenantSlug={tenantSlug} showStudentLink={showStudentLink} onDecided={(d) => setDecided((prev) => [d, ...prev].slice(0, 5))} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Mode = "view" | "edit" | "dismiss";

function ActionCardItem({ card, tenantSlug, showStudentLink, onDecided }: { card: InboxCardView; tenantSlug: string; showStudentLink: boolean; onDecided: (d: Decided) => void }) {
  const t = useTranslations("success");
  const tRoles = useTranslations("roles");
  const format = useFormatter();
  const [mode, setMode] = useState<Mode>("view");
  const formId = useId();
  const [state, formAction, pending] = useActionState(async (prev: DecisionState, fd: FormData): Promise<DecisionState> => {
    const r = await decideCardAction(prev, fd);
    if (r.status === "ok") onDecided({ id: r.actionCardId, student: card.student.name, outcome: r.outcome, track: r.track });
    return r;
  }, { status: "idle" });

  const pct = (n: number) => format.number(n, { style: "percent", maximumFractionDigits: 0 });
  const pts = (n: number) => format.number(n, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const signed = (n: number) => format.number(n, { maximumFractionDigits: 2, signDisplay: "exceptZero" });
  const level = confidenceLevel(card.confidence);
  const ev = card.evidence;
  const maxVs = ev ? Math.max(1, ...ev.topFactors.map((f) => Math.abs(f.vsBaseline ?? f.contribution))) : 1;

  const hidden = (decision: string) => (
    <>
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      <input type="hidden" name="actionCardId" value={card.id} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <Card data-testid="action-card" data-card-id={card.id} data-student-id={card.student.id} className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(`cardTypes.${card.type}`)}</p>
          <h3 className="truncate text-base font-semibold">
            {showStudentLink ? (
              <Link href={`/t/${tenantSlug}/students/${card.student.id}`} className="hover:underline" data-testid="card-student-link">
                {card.student.name}
              </Link>
            ) : (
              card.student.name
            )}
          </h3>
          {card.proposal ? (
            <p className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="card-proposal">
              <Badge variant="neutral">{card.proposal.fromTrack ? t(`tracks.${card.proposal.fromTrack}`) : t("inbox.noTrack")}</Badge>
              <ArrowRight className="size-4 text-muted-foreground rtl:rotate-180" aria-label={t("inbox.to")} />
              <Badge variant={TRACK_VARIANT[card.proposal.track]} data-testid="card-proposed-track" data-track={card.proposal.track}>
                {t(`tracks.${card.proposal.track}`)}
              </Badge>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1 sm:items-end" data-testid="card-confidence" data-level={level}>
          <span className="text-xs text-muted-foreground">{t("inbox.confidence")}</span>
          <span className="flex items-center gap-2">
            <span className="text-lg font-semibold tabular-nums">{pct(card.confidence)}</span>
            <Badge variant={level === "high" ? "success" : level === "medium" ? "neutral" : "warn"}>{t(`confidence.${level}`)}</Badge>
          </span>
          <span className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(card.confidence * 100)} aria-label={t("inbox.confidence")}>
            <span className="block h-full rounded-full bg-brand" style={{ width: `${barPercent(card.confidence, 1)}%` }} />
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {ev ? (
          <div className="rounded-md border border-border p-3" data-testid="evidence-panel">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-sm text-muted-foreground">{t("risk.score")}</span>
              <span className="text-2xl font-semibold tabular-nums" data-testid="evidence-score">
                {pts(ev.score)}
              </span>
              <Badge variant={BAND_VARIANT[ev.band]} data-testid="evidence-band" data-band={ev.band}>
                {t(`bands.${ev.band}`)}
              </Badge>
              {ev.cohortScore !== null ? (
                <span className="text-sm text-muted-foreground">{t("risk.cohortMean", { score: pts(ev.cohortScore), grade: ev.cohortGrade ?? "—" })}</span>
              ) : null}
              {ev.coverage !== null ? <span className="text-sm text-muted-foreground">{t("inbox.coverage", { pct: pct(ev.coverage) })}</span> : null}
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("inbox.noEvidence")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("inbox.meta", { role: tRoles.has(card.assigneeRole) ? tRoles(card.assigneeRole) : card.assigneeRole, created: card.createdAt })}
          {card.expiresAt ? <> · {t("inbox.expires", { at: card.expiresAt })}</> : null}
        </p>

        {state.status === "error" ? (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-foreground" data-testid="card-error" data-code={state.code}>
            {t(`errors.${state.code}`)}
          </p>
        ) : null}

        {card.canDecide && mode === "edit" && card.proposal ? (
          <form action={formAction} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" data-testid="edit-form">
            {hidden("edit")}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-track`}>{t("inbox.edit.track")}</Label>
              <select
                id={`${formId}-track`}
                name="track"
                defaultValue={card.proposal.track}
                className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                data-testid="edit-track"
              >
                {TRACKS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`tracks.${tr}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-eff`}>{t("inbox.edit.effectiveDate")}</Label>
              <Input id={`${formId}-eff`} name="effectiveDate" type="date" defaultValue={card.proposal.defaultEffectiveDate} dir="ltr" data-testid="edit-effective" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-rev`}>{t("inbox.edit.reviewDate")}</Label>
              <Input id={`${formId}-rev`} name="reviewDate" type="date" defaultValue={card.proposal.defaultReviewDate} dir="ltr" data-testid="edit-review" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-note`}>{t("inbox.note")}</Label>
              <Input id={`${formId}-note`} name="note" maxLength={1000} data-testid="edit-note" />
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={pending} data-testid="edit-submit">
                {pending ? t("inbox.saving") : t("inbox.edit.submit")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMode("view")} disabled={pending}>
                {t("inbox.cancel")}
              </Button>
            </div>
          </form>
        ) : null}

        {card.canDecide && mode === "dismiss" ? (
          <form action={formAction} className="flex flex-col gap-3 rounded-md border border-border p-3" data-testid="dismiss-form">
            {hidden("dismiss")}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-dnote`}>{t("inbox.dismissReason")}</Label>
              <Input id={`${formId}-dnote`} name="note" maxLength={1000} data-testid="dismiss-note" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" disabled={pending} data-testid="dismiss-submit">
                {pending ? t("inbox.saving") : t("inbox.dismissConfirm")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMode("view")} disabled={pending}>
                {t("inbox.cancel")}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {card.canDecide ? (
          mode === "view" ? (
            <>
              {card.proposal ? (
                <form action={formAction}>
                  {hidden("approve")}
                  <Button type="submit" disabled={pending} data-testid="card-approve">
                    <Check aria-hidden />
                    {pending ? t("inbox.saving") : t("inbox.approve")}
                  </Button>
                </form>
              ) : null}
              {card.proposal ? (
                <Button type="button" variant="outline" onClick={() => setMode("edit")} disabled={pending} data-testid="card-edit">
                  <Pencil aria-hidden />
                  {t("inbox.edit.open")}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" onClick={() => setMode("dismiss")} disabled={pending} data-testid="card-dismiss">
                <X aria-hidden />
                {t("inbox.dismiss")}
              </Button>
            </>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="card-readonly">
            {t("inbox.readOnly", { role: tRoles.has(card.assigneeRole) ? tRoles(card.assigneeRole) : card.assigneeRole })}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
