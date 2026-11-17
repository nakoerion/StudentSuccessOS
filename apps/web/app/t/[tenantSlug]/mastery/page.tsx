import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { MasteryClassPicker } from "../../../../components/mastery-class-picker";
import { canViewMastery } from "../../../../lib/access";
import { AiServiceError, createAiClient, type MasteryResult } from "../../../../lib/ai/client";
import {
  buildGrid,
  gridIsEmpty,
  loadClassStudents,
  loadConceptNames,
  loadMasteryClasses,
  MASTERY_LEVELS,
  masteryLevel,
  type MasteryLevel,
  summarizeConcepts,
} from "../../../../lib/ai/mastery";
import { requireTenant } from "../../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;
type SearchParams = Promise<{ class?: string | string[] }>;

export const dynamic = "force-dynamic";

const LEVEL_CLASS: Record<MasteryLevel, string> = {
  low: "bg-rose-600 text-white",
  developing: "bg-amber-400 text-amber-950",
  secure: "bg-lime-400 text-lime-950",
  strong: "bg-emerald-600 text-white",
};
const NO_DATA_CLASS = "border border-dashed border-border bg-transparent text-muted-foreground";
/** How many of the weakest concepts the class summary names. */
const SUMMARY_SIZE = 5;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("mastery");
  return { title: `${t("title")} · ${membership.name}` };
}

function Panel({ testId, title, body }: { testId: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-6" data-testid={testId}>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export default async function MasteryPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { tenantSlug } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  // Enforced here, not only by hiding the nav link: students and parents get a 404.
  if (!canViewMastery(viewer)) notFound();
  const t = await getTranslations("mastery");
  const format = await getFormatter();
  const pct = (p: number) => format.number(p, { style: "percent", maximumFractionDigits: 0 });

  const classes = await db((tx) => loadMasteryClasses(tx));
  const requested = (await searchParams).class;
  const selected = classes.find((c) => c.id === (Array.isArray(requested) ? requested[0] : requested)) ?? classes[0];

  const header = (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="mastery-title">
          {t("title")}
        </h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t("subtitle")}</p>
      </div>
      {selected ? <MasteryClassPicker classes={classes} selected={selected.id} /> : null}
    </div>
  );

  if (!selected) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Panel testId="mastery-no-classes" title={t("noClasses.title")} body={t("noClasses.body")} />
      </div>
    );
  }

  const students = await db((tx) => loadClassStudents(tx, selected.id));
  let result: MasteryResult | null = null;
  if (students.length > 0) {
    try {
      result = await createAiClient(membership.tenantId).mastery({ studentIds: students.map((s) => s.id) });
    } catch (err) {
      if (!(err instanceof AiServiceError)) throw err;
    }
  }

  let body: ReactNode;
  if (students.length === 0) {
    body = <Panel testId="mastery-no-students" title={t("noStudents.title")} body={t("noStudents.body")} />;
  } else if (!result) {
    body = <Panel testId="mastery-unavailable" title={t("unavailable.title")} body={t("unavailable.body")} />;
  } else {
    const grid = buildGrid(result, students.map((s) => s.id));
    if (gridIsEmpty(grid)) {
      body = <Panel testId="mastery-empty" title={t("empty.title")} body={t("empty.body")} />;
    } else {
      const names = await db((tx) => loadConceptNames(tx, membership.tenantId, grid.concepts));
      const label = (code: string) => names[code] ?? code;
      const summary = summarizeConcepts(grid).slice(0, SUMMARY_SIZE);
      const studentName = new Map(students.map((s) => [s.id, s.name]));
      const unassessed = grid.rows.filter((r) => Object.values(r.cells).every((c) => c === null)).length;

      body = (
        <>
          <section className="rounded-lg border border-border bg-surface p-5" data-testid="mastery-summary">
            <h2 className="text-lg font-semibold">{t("summary.title", { className: selected.name })}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("summary.subtitle")}</p>
            <ol className="mt-4 flex flex-col gap-3">
              {summary.map((s, i) => (
                <li key={s.conceptCode} className="flex items-center gap-3" data-testid="mastery-weak-concept">
                  <span className="w-6 shrink-0 text-center text-sm font-semibold text-muted-foreground">{format.number(i + 1)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">{label(s.conceptCode)}</span>
                      <span className="text-sm tabular-nums">
                        {t("summary.average", { value: pct(s.average) })}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={`h-full ${LEVEL_CLASS[masteryLevel(s.average)]}`} style={{ width: `${Math.round(s.average * 100)}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <bdi dir="ltr">{s.conceptCode}</bdi> · {t("summary.assessed", { count: s.assessed, total: students.length })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="flex flex-col gap-3" data-testid="mastery-grid">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{t("grid.title")}</h2>
              <ul className="flex flex-wrap items-center gap-3 text-xs" aria-label={t("legend.title")}>
                {MASTERY_LEVELS.map((l) => (
                  <li key={l} className="flex items-center gap-1.5">
                    <span className={`inline-block size-3 rounded-sm ${LEVEL_CLASS[l]}`} aria-hidden />
                    {t(`levels.${l}`)}
                  </li>
                ))}
                <li className="flex items-center gap-1.5">
                  <span className={`inline-block size-3 rounded-sm ${NO_DATA_CLASS}`} aria-hidden />
                  {t("legend.noData")}
                </li>
              </ul>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full border-separate border-spacing-1 text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-2 text-start font-medium text-muted-foreground">
                      {t("grid.student")}
                    </th>
                    {grid.concepts.map((code) => (
                      <th key={code} scope="col" className="min-w-24 px-2 py-2 text-center align-bottom font-medium" title={code}>
                        <span className="block">{label(code)}</span>
                        <bdi dir="ltr" className="block text-[11px] font-normal text-muted-foreground">
                          {code}
                        </bdi>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row) => {
                    const name = studentName.get(row.studentId) ?? "";
                    return (
                      <tr key={row.studentId} data-testid="mastery-row">
                        <th scope="row" className="whitespace-nowrap px-2 py-1 text-start font-normal">
                          {name}
                        </th>
                        {grid.concepts.map((code) => {
                          const c = row.cells[code];
                          if (!c) {
                            const title = t("grid.noDataTitle", { student: name, concept: label(code) });
                            return (
                              <td key={code} className={`rounded-md px-2 py-1.5 text-center ${NO_DATA_CLASS}`} title={title} data-testid="mastery-cell-empty">
                                <span className="block text-xs">{t("grid.noData")}</span>
                                <span className="sr-only">{title}</span>
                              </td>
                            );
                          }
                          const title = t("grid.cellTitle", {
                            student: name,
                            concept: label(code),
                            value: pct(c.pMastery),
                            correct: c.correct,
                            attempts: c.attempts,
                          });
                          return (
                            <td key={code} className={`rounded-md px-2 py-1.5 text-center ${LEVEL_CLASS[masteryLevel(c.pMastery)]}`} title={title} data-testid="mastery-cell">
                              <span className="block font-semibold tabular-nums">{pct(c.pMastery)}</span>
                              <span className="block text-[11px] opacity-90">{t("grid.attempts", { count: c.attempts })}</span>
                              <span className="sr-only">{title}</span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {unassessed > 0 ? `${t("grid.unassessed", { count: unassessed })} ` : ""}
              {t("grid.note")}
            </p>
          </section>
        </>
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {body}
    </div>
  );
}
