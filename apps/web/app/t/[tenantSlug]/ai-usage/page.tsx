import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Calculator, Info } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { PageHeader, StatePanel } from "../../../../components/page";

import { canViewAiUsage } from "../../../../lib/access";
import { AiServiceError, createAiClient, type BudgetPool, type EvalRun, type UsageReport } from "../../../../lib/ai/client";
import { barGeometry, CAP_FORMAT, capLine, essentialLine, evalQuality, poolState, SPEND_FORMAT, type PoolState } from "../../../../lib/ai/usage";
import { requireTenant } from "../../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;

export const dynamic = "force-dynamic";

const POOLS: readonly BudgetPool[] = ["discretionary", "essential"];
const FILL_CLASS: Record<PoolState, string> = { ok: "bg-status-good", warning: "bg-status-watch", exhausted: "bg-status-risk" };
const BADGE_CLASS: Record<PoolState, string> = {
  ok: "bg-status-good-subtle text-success-foreground",
  warning: "bg-status-watch-subtle text-warn-foreground",
  exhausted: "bg-status-risk-subtle text-danger-foreground",
};
const NEUTRAL_BADGE = "bg-muted text-muted-foreground border border-dashed border-border";

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("aiUsage");
  return { title: `${t("title")} · ${membership.name}` };
}

const Panel = StatePanel;

export default async function AiUsagePage({ params }: { params: Params }) {
  const { tenantSlug } = await params;
  const { membership, viewer } = await requireTenant(tenantSlug);
  // Enforced here, not only by hiding the nav link: everyone but the school's admins gets a 404.
  if (!canViewAiUsage(viewer)) notFound();
  const t = await getTranslations("aiUsage");
  const format = await getFormatter();
  const cap = (n: number) => format.number(n, CAP_FORMAT);
  const spend = (n: number) => format.number(n, SPEND_FORMAT);
  const pct = (n: number) => format.number(n, { style: "percent", maximumFractionDigits: 0 });

  const ai = createAiClient(membership.tenantId);
  const [usage, runs] = await Promise.all([
    ai.usage().catch((err: unknown): UsageReport | null => {
      if (err instanceof AiServiceError) return null;
      throw err;
    }),
    ai.latestEvals().catch((err: unknown): EvalRun[] | null => {
      if (err instanceof AiServiceError) return null;
      throw err;
    }),
  ]);

  const lineValues = (values: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, k === "seats" ? format.number(v) : k === "share" ? pct(v) : cap(v)]),
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} testId="ai-usage-title" />

      {!usage ? (
        <Panel testId="ai-usage-unavailable" title={t("unavailable.title")} body={t("unavailable.body")} />
      ) : (
        <>
          {usage.nominal ? (
            <div className="flex gap-3 rounded-lg border border-warn/40 bg-warn-subtle p-4 text-warn-foreground" data-testid="ai-usage-nominal">
              <Info className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">{t("nominal.title")}</p>
                <p className="mt-1 text-sm">{t("nominal.body")}</p>
              </div>
            </div>
          ) : null}

          <section className="flex flex-col gap-3" data-testid="ai-usage-pools">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">{t("pools.title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("pools.month", { date: format.dateTime(new Date(usage.monthStart), { year: "numeric", month: "long", timeZone: "UTC" }) })}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {POOLS.map((pool) => {
                const p = usage.pools[pool];
                const state = poolState(p);
                const { fill, warningAt } = barGeometry(p);
                return (
                  <article key={pool} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5" data-testid={`ai-usage-pool-${pool}`} data-state={state}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">{t(`pools.${pool}.name`)}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{t(`pools.${pool}.body`)}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_CLASS[state]}`} data-testid="ai-usage-pool-state">
                        {state === "exhausted" && !p.hardStop ? t("state.exhaustedEssential") : t(`state.${state}`)}
                      </span>
                    </div>
                    <dl className="grid grid-cols-3 gap-2 rounded-md bg-muted/50 p-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("plain.spent")}</dt>
                        <dd className="text-xl font-semibold tabular-nums" data-testid="ai-usage-spent">
                          <bdi>{spend(p.spentUsd)}</bdi>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("plain.cap")}</dt>
                        <dd className="text-xl font-semibold tabular-nums">
                          <bdi>{cap(p.capUsd)}</bdi>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("plain.left")}</dt>
                        <dd className="text-xl font-semibold tabular-nums">
                          <bdi>{spend(p.remainingUsd)}</bdi>
                        </dd>
                      </div>
                    </dl>
                    <div
                      className="relative h-3 rounded-full bg-muted"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={p.capUsd}
                      aria-valuenow={Math.min(p.spentUsd, p.capUsd)}
                      aria-label={t(`pools.${pool}.name`)}
                    >
                      <div className={`h-full rounded-full ${FILL_CLASS[state]}`} style={{ width: `${fill}%` }} />
                      <div
                        className="absolute -top-1 h-5 w-0.5 bg-foreground/70"
                        style={{ insetInlineStart: `${warningAt}%` }}
                        title={t("pools.warningLine", { pct: pct(p.warningRatio) })}
                        data-testid="ai-usage-warning-line"
                      />
                    </div>
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{t("pools.used", { pct: pct(p.usedRatio) })}</span>
                      <span>{t("pools.warningLine", { pct: pct(p.warningRatio) })}</span>
                      <span>{t("pools.calls", { count: p.calls })}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface p-5" data-testid="ai-usage-derivation">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Calculator className="size-5 text-muted-foreground" aria-hidden />
              {t("plain.howWorkedOut")}
            </h2>
            {(() => {
              const d = capLine(usage.derivation.discretionary);
              const e = essentialLine(usage.derivation.essential);
              return (
                <>
                  <p className="mt-3 rounded-md border border-brand/30 bg-brand-subtle px-3 py-2 font-medium text-brand-subtle-foreground" data-testid="ai-usage-cap-line" data-basis={usage.derivation.discretionary.basis}>
                    {t(d.key, lineValues(d.values))}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{t(e.key, lineValues(e.values))}</p>
                  {usage.derivation.discretionary.basis === "floor" && usage.derivation.discretionary.seatCount === null ? (
                    <p className="mt-1 text-sm text-muted-foreground">{t("derivation.noSeatsWhy")}</p>
                  ) : null}
                </>
              );
            })()}
          </section>
        </>
      )}

      <section className="flex flex-col gap-3" data-testid="ai-usage-evals">
        <div>
          <h2 className="text-lg font-semibold">{t("evals.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("evals.subtitle")}</p>
        </div>
        {runs === null ? (
          <Panel testId="ai-usage-evals-unavailable" title={t("unavailable.title")} body={t("evals.unavailable")} />
        ) : runs.length === 0 ? (
          <Panel testId="ai-usage-evals-empty" title={t("evals.empty.title")} body={t("evals.empty.body")} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t("evals.suite")}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t("evals.ran")}</th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">{t("evals.cases")}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t("evals.result")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const q = evalQuality(run);
                  return (
                    <tr key={run.id} className="border-b border-border last:border-0" data-testid="ai-usage-eval-row" data-quality={q.kind}>
                      <td className="px-4 py-2">
                        <bdi dir="ltr" className="font-medium">{run.suiteId}</bdi>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {format.dateTime(new Date(run.finishedAt), { dateStyle: "medium", timeStyle: "short" })}
                      </td>
                      <td className="px-4 py-2 text-end tabular-nums">{format.number(run.cases)}</td>
                      <td className="px-4 py-2">
                        {q.kind === "not_measured" ? (
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${NEUTRAL_BADGE}`} data-testid="ai-usage-eval-result">
                            {t("evals.notMeasured")}
                          </span>
                        ) : q.kind === "partial" ? (
                          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${NEUTRAL_BADGE}`} data-testid="ai-usage-eval-result">
                            {t("evals.partial", { pct: pct(q.score), count: q.measured })}
                          </span>
                        ) : (
                          <span
                            className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${q.tone === "good" ? "bg-status-good-subtle text-success-foreground" : "bg-status-risk-subtle text-danger-foreground"}`}
                            data-testid="ai-usage-eval-result"
                          >
                            {t(q.tone === "good" ? "evals.quality" : "evals.qualityBelow", { pct: pct(q.score) })}
                          </span>
                        )}
                        <span className="ms-2 text-xs text-muted-foreground">
                          {t(q.kind === "not_measured" ? "evals.plumbing" : "evals.passed", { passed: run.passed, cases: run.cases })}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
