import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ssos/ui";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { ActionInbox } from "../../../../../components/action-inbox";
import { canViewSuccess } from "../../../../../lib/access";
import { requireTenant } from "../../../../../lib/session";
import {
  loadInboxCards,
  loadRiskPanel,
  loadStudentAlerts,
  loadStudentHeader,
  loadTrackHistory,
  makeDateFormatters,
  tenantTimeZone,
  type AlertRow,
} from "../../../../../lib/success";
import { BAND_VARIANT, barPercent, KNOWN_ALERT_RULES, splitMinutes, sumContributions, TRACK_VARIANT } from "../../../../../lib/success-view";

type Params = Promise<{ tenantSlug: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenantSlug, id } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  const t = await getTranslations("success.profile");
  const header = canViewSuccess(viewer) ? await db((tx) => loadStudentHeader(tx, id)) : null;
  return { title: `${header?.name ?? t("title")} · ${membership.name}` };
}

const SEVERITY_VARIANT = { info: "neutral", warning: "warn", critical: "danger" } as const;
const STATE_VARIANT = { open: "warn", escalated: "danger", acknowledged: "default", resolved: "success", dismissed: "neutral" } as const;

export default async function StudentProfilePage({ params }: { params: Params }) {
  const { tenantSlug, id } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  if (!canViewSuccess(viewer)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("success");
  const tRoles = await getTranslations("roles");
  const format = await getFormatter();

  const data = await db(async (tx) => {
    const header = await loadStudentHeader(tx, id);
    if (!header) return null;
    const fmt = makeDateFormatters(locale, await tenantTimeZone(tx, membership.tenantId));
    const [risk, tracks, alerts, cards] = await Promise.all([
      loadRiskPanel(tx, membership.tenantId, id, fmt),
      loadTrackHistory(tx, membership.tenantId, id, fmt),
      loadStudentAlerts(tx, membership.tenantId, id, fmt),
      loadInboxCards(tx, { tenantId: membership.tenantId, viewer, fmt, subjectPersonId: id }),
    ]);
    return { header, risk, tracks, alerts, cards };
  });
  if (!data) notFound();
  const { header, risk, tracks, alerts, cards } = data;

  const pts = (n: number) => format.number(n, { maximumFractionDigits: 2 });
  const signed = (n: number) => format.number(n, { maximumFractionDigits: 2, signDisplay: "exceptZero" });
  const pct = (n: number) => format.number(n, { style: "percent", maximumFractionDigits: 1 });
  const role = (r: string) => (tRoles.has(r) ? tRoles(r) : r);
  const activeTrack = tracks.find((r) => r.status === "active");
  const maxVs = risk ? Math.max(1, ...risk.factors.map((f) => Math.abs(f.vsBaseline ?? 0))) : 1;
  const duration = (minutes: number) => {
    const { days, hours, minutes: m } = splitMinutes(minutes);
    return t("alerts.duration", { days, hours, minutes: m });
  };
  const ruleLabel = (a: AlertRow) => ((KNOWN_ALERT_RULES as readonly string[]).includes(a.ruleKey) ? t(`alertRules.${a.ruleKey}`) : a.ruleName);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href={`/t/${tenantSlug}/people?role=student`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
          {t("profile.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="student-name">
            {header.name}
          </h1>
          {activeTrack ? (
            <Badge variant={TRACK_VARIANT[activeTrack.track]} data-testid="current-track" data-track={activeTrack.track}>
              {t("profile.trackBadge", { track: t(`tracks.${activeTrack.track}`) })}
            </Badge>
          ) : (
            <Badge variant="neutral" data-testid="current-track" data-track="none">
              {t("profile.noTrack")}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">
          {header.units.join(", ") || t("none")}
          {header.externalRef ? (
            <>
              {" · "}
              <span className="font-mono text-xs" dir="ltr">
                {header.externalRef}
              </span>
            </>
          ) : null}
        </p>
      </div>

      {/* Risk explanation */}
      <Card data-testid="risk-panel">
        <CardHeader>
          <CardTitle>{t("risk.title")}</CardTitle>
          <CardDescription>{t("risk.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {risk ? (
            <>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">{t("risk.score")}</p>
                  <p className="text-4xl font-semibold tabular-nums" data-testid="risk-score">
                    {pts(risk.score)}
                    <span className="text-base font-normal text-muted-foreground"> / {format.number(100)}</span>
                  </p>
                </div>
                <Badge variant={BAND_VARIANT[risk.band]} className="mb-1.5 text-sm" data-testid="risk-band" data-band={risk.band}>
                  {t("risk.bandLabel", { band: t(`bands.${risk.band}`) })}
                </Badge>
                <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">{t("risk.cohort")}</dt>
                  <dd data-testid="risk-cohort">
                    {t("risk.cohortValue", { grade: risk.cohort.grade ?? "—", size: risk.cohort.size, scored: risk.cohort.scored })}
                  </dd>
                  <dt className="text-muted-foreground">{t("risk.cohortScore")}</dt>
                  <dd className="tabular-nums">{risk.cohort.score === null ? t("none") : pts(risk.cohort.score)}</dd>
                  <dt className="text-muted-foreground">{t("risk.model")}</dt>
                  <dd>{t("risk.modelValue", { version: risk.modelVersion, at: risk.computedAt })}</dd>
                </dl>
              </div>

              <div className="overflow-x-auto">
                <Table data-testid="risk-factors">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("risk.columns.factor")}</TableHead>
                      <TableHead>{t("risk.columns.signal")}</TableHead>
                      <TableHead className="text-end">{t("risk.columns.risk")}</TableHead>
                      <TableHead className="text-end">{t("risk.columns.weight")}</TableHead>
                      <TableHead className="text-end">{t("risk.columns.contribution")}</TableHead>
                      <TableHead className="text-end">{t("risk.columns.baseline")}</TableHead>
                      <TableHead className="min-w-44">{t("risk.columns.vsBaseline")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {risk.factors.map((f) => {
                      const vs = f.vsBaseline;
                      return (
                        <TableRow key={f.factor} data-testid="risk-factor-row" data-factor={f.factor} data-available={f.available} data-top={f.top} className={cn(!f.available && "text-muted-foreground")}>
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {t(`factors.${f.factor}`)}
                              {f.top ? <Badge variant="outline">{t("risk.topBadge", { rank: f.rank ?? 0 })}</Badge> : null}
                            </span>
                          </TableCell>
                          <TableCell>{f.available && f.value !== null ? t(`factorValue.${f.factor}`, { value: f.value }) : t("risk.noData")}</TableCell>
                          <TableCell className="text-end tabular-nums">{f.risk === null ? t("none") : pts(f.risk)}</TableCell>
                          <TableCell className="text-end tabular-nums">{f.available ? pct(f.effectiveWeight) : t("none")}</TableCell>
                          <TableCell className="text-end font-medium tabular-nums" data-testid="factor-contribution">
                            {pts(f.contribution)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{f.baseline === null ? t("none") : pts(f.baseline)}</TableCell>
                          <TableCell>
                            {vs === null ? (
                              <span className="text-muted-foreground">{t("none")}</span>
                            ) : (
                              <span className="flex items-center gap-2">
                                {/* Diverging bar: below the cohort grows toward start, above toward end. */}
                                <span className="grid h-2 w-24 grid-cols-2" aria-hidden>
                                  <span className="flex justify-end">
                                    {vs < 0 ? <span className="block h-2 rounded-s-full bg-success/70" style={{ width: `${barPercent(vs, maxVs)}%` }} /> : null}
                                  </span>
                                  <span className="flex justify-start border-s border-border">
                                    {vs > 0 ? <span className="block h-2 rounded-e-full bg-danger/70" style={{ width: `${barPercent(vs, maxVs)}%` }} /> : null}
                                  </span>
                                </span>
                                <span className="tabular-nums" data-testid="factor-vs-baseline">
                                  {signed(vs)}
                                </span>
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/50">
                      <TableCell colSpan={4} className="font-medium">
                        {t("risk.total")}
                      </TableCell>
                      <TableCell className="text-end font-semibold tabular-nums" data-testid="factor-total">
                        {pts(sumContributions(risk.factors))}
                      </TableCell>
                      <TableCell colSpan={2} className="text-sm text-muted-foreground">
                        {t("risk.totalHint")}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">{t("risk.explainer")}</p>
            </>
          ) : (
            <p className="text-muted-foreground" data-testid="risk-empty">
              {t("risk.empty")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Open action cards about this student */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("profile.openCards")}</h2>
        <ActionInbox tenantSlug={tenantSlug} cards={cards} showStudentLink={false} emptyLabel={t("profile.noOpenCards")} />
      </section>

      {/* Track history */}
      <Card className="overflow-hidden" data-testid="track-history">
        <CardHeader>
          <CardTitle>{t("trackHistory.title")}</CardTitle>
          <CardDescription>{t("trackHistory.subtitle")}</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("trackHistory.columns.track")}</TableHead>
              <TableHead>{t("trackHistory.columns.status")}</TableHead>
              <TableHead>{t("trackHistory.columns.effective")}</TableHead>
              <TableHead>{t("trackHistory.columns.review")}</TableHead>
              <TableHead className="text-end">{t("trackHistory.columns.confidence")}</TableHead>
              <TableHead>{t("trackHistory.columns.decision")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground" data-testid="track-history-empty">
                  {t("trackHistory.empty")}
                </TableCell>
              </TableRow>
            ) : (
              tracks.map((r) => (
                <TableRow key={r.id} data-testid="track-row" data-track={r.track} data-status={r.status}>
                  <TableCell>
                    <Badge variant={TRACK_VARIANT[r.track]}>{t(`tracks.${r.track}`)}</Badge>
                  </TableCell>
                  <TableCell>{t(`trackStatus.${r.status}`)}</TableCell>
                  <TableCell>{r.effectiveDate}</TableCell>
                  <TableCell>{r.reviewDate ?? t("none")}</TableCell>
                  <TableCell className="text-end tabular-nums">{format.number(r.confidence, { style: "percent", maximumFractionDigits: 0 })}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.decision
                      ? t("trackHistory.decidedBy", { status: r.decision.status, by: r.decision.by ?? "—", at: r.decision.at ?? "—" })
                      : t("none")}
                    {r.decision?.note ? <span className="block text-xs">“{r.decision.note}”</span> : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Alerts */}
      <Card className="overflow-hidden" data-testid="alerts-list">
        <CardHeader>
          <CardTitle>{t("alerts.title")}</CardTitle>
          <CardDescription>{t("alerts.subtitle")}</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("alerts.columns.rule")}</TableHead>
              <TableHead>{t("alerts.columns.state")}</TableHead>
              <TableHead>{t("alerts.columns.rung")}</TableHead>
              <TableHead>{t("alerts.columns.due")}</TableHead>
              <TableHead>{t("alerts.columns.acknowledged")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground" data-testid="alerts-empty">
                  {t("alerts.empty")}
                </TableCell>
              </TableRow>
            ) : (
              alerts.map((a) => (
                <TableRow key={a.id} data-testid="alert-row" data-state={a.state}>
                  <TableCell>
                    <span className="flex flex-col gap-1">
                      <span className="font-medium">{ruleLabel(a)}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={SEVERITY_VARIANT[a.severity as keyof typeof SEVERITY_VARIANT] ?? "neutral"}>{t(`severity.${a.severity}`)}</Badge>
                        {t("alerts.triggered", { at: a.triggeredAt })}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_VARIANT[a.state]} data-testid="alert-state">
                      {t(`alertStates.${a.state}`)}
                    </Badge>
                  </TableCell>
                  <TableCell data-testid="alert-rung">{t("alerts.rung", { rung: a.rung.rung, of: a.rung.of, role: role(a.rung.role) })}</TableCell>
                  <TableCell data-testid="alert-due">
                    {a.dueAt ? <span className="block">{a.dueAt}</span> : <span className="text-muted-foreground">{t("alerts.noTimer")}</span>}
                    {a.sla.kind === "due" ? (
                      <span className="text-xs text-muted-foreground">{t("alerts.dueIn", { duration: duration(a.sla.minutesLeft) })}</span>
                    ) : a.sla.kind === "overdue" ? (
                      <span className="text-xs font-medium text-danger">{t("alerts.overdue", { duration: duration(a.sla.minutesOver) })}</span>
                    ) : null}
                  </TableCell>
                  <TableCell data-testid="alert-ack">
                    {a.acknowledgements.length === 0 ? (
                      <span className="text-muted-foreground">{t("alerts.notAcknowledged")}</span>
                    ) : (
                      a.acknowledgements.map((k, i) => (
                        <span key={i} className="block text-sm">
                          {t("alerts.ackBy", { by: k.by, role: role(k.role), at: k.at })}
                        </span>
                      ))
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
