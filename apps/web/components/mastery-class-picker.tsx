"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

/** Class picker for the mastery heatmap: navigates to `?class=<id>`; the server reads the rest. */
export function MasteryClassPicker({
  classes,
  selected,
}: {
  classes: { id: string; name: string }[];
  selected: string;
}) {
  const t = useTranslations("mastery");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="flex flex-wrap items-center gap-3 text-sm font-medium">
      {t("classLabel")}
      <select
        data-testid="mastery-class"
        className="h-9 min-w-48 rounded-md border border-border bg-surface px-3 text-sm"
        value={selected}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          start(() => router.push(`?class=${encodeURIComponent(id)}`));
        }}
      >
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {pending ? <span className="text-xs text-muted-foreground">{t("loading")}</span> : null}
    </label>
  );
}
