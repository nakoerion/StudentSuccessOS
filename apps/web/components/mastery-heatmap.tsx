"use client";

/**
 * Student × concept mastery grid with a sticky header row and first column, and row/column
 * highlighting on hover or focus. All strings arrive pre-formatted from the server.
 * A null cell is "no data" (not attempted): it is drawn dashed and empty, never as a low
 * score — the two mean opposite things about a child.
 */
import { cn } from "@ssos/ui";
import { useState } from "react";

import { type HeatLevel, LEVEL_CLASS, NO_DATA_CLASS } from "../lib/ai/mastery-style";

export interface HeatCell {
  value: string;
  attempts: string;
  title: string;
  level: HeatLevel;
}

export function MasteryHeatmap({
  studentLabel,
  noDataLabel,
  concepts,
  rows,
}: {
  studentLabel: string;
  noDataLabel: string;
  concepts: { code: string; label: string }[];
  rows: { id: string; name: string; cells: (HeatCell | { noDataTitle: string })[] }[];
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface" onMouseLeave={() => setHover(null)}>
      <table className="w-full border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th scope="col" className="sticky start-0 top-0 z-30 bg-surface px-2 py-2 text-start font-medium text-muted-foreground">
              {studentLabel}
            </th>
            {concepts.map((c, ci) => (
              <th
                key={c.code}
                scope="col"
                className={cn(
                  "sticky top-0 z-20 min-w-24 rounded-md bg-surface px-2 py-2 text-center align-bottom font-medium transition-colors duration-150",
                  hover?.c === ci && "bg-brand-subtle text-brand-subtle-foreground",
                )}
                title={c.code}
              >
                <span className="block">{c.label}</span>
                <bdi dir="ltr" className="block text-[11px] font-normal text-muted-foreground">
                  {c.code}
                </bdi>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id} data-testid="mastery-row">
              <th
                scope="row"
                className={cn(
                  "sticky start-0 z-10 whitespace-nowrap rounded-md bg-surface px-2 py-1 text-start font-normal transition-colors duration-150",
                  hover?.r === ri && "bg-brand-subtle font-medium text-brand-subtle-foreground",
                )}
              >
                {row.name}
              </th>
              {row.cells.map((cell, ci) => {
                const active = hover !== null && (hover.r === ri || hover.c === ci);
                const here = hover?.r === ri && hover?.c === ci;
                const common = {
                  onMouseEnter: () => setHover({ r: ri, c: ci }),
                  onFocus: () => setHover({ r: ri, c: ci }),
                  tabIndex: 0,
                };
                if ("noDataTitle" in cell) {
                  return (
                    <td
                      key={concepts[ci]!.code}
                      {...common}
                      className={cn("rounded-md px-2 py-1.5 text-center transition-opacity duration-150", NO_DATA_CLASS, hover && !active && "opacity-60", here && "ring-2 ring-ring")}
                      title={cell.noDataTitle}
                      data-testid="mastery-cell-empty"
                    >
                      <span className="block text-xs">{noDataLabel}</span>
                      <span className="sr-only">{cell.noDataTitle}</span>
                    </td>
                  );
                }
                return (
                  <td
                    key={concepts[ci]!.code}
                    {...common}
                    className={cn("rounded-md px-2 py-1.5 text-center transition-opacity duration-150", LEVEL_CLASS[cell.level], hover && !active && "opacity-60", here && "ring-2 ring-ring")}
                    title={cell.title}
                    data-testid="mastery-cell"
                  >
                    <span className="block font-semibold tabular-nums">{cell.value}</span>
                    <span className="block text-[11px] opacity-90">{cell.attempts}</span>
                    <span className="sr-only">{cell.title}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
