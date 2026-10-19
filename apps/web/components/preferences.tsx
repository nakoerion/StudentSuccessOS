"use client";

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ssos/ui";
import { Languages, Moon, Sun } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { setLocaleAction, setThemeAction } from "../app/actions";
import { LOCALES } from "../i18n/config";

export function LocaleSwitcher() {
  const t = useTranslations("common");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  return (
    <Select
      value={locale}
      disabled={pending}
      onValueChange={(next) =>
        startTransition(async () => {
          await setLocaleAction(next);
          // Full reload so <html lang/dir> and every server component switch together.
          window.location.reload();
        })
      }
    >
      <SelectTrigger aria-label={t("language")} className="h-9 w-auto gap-1.5" data-testid="locale-switcher">
        <Languages className="size-4 opacity-70" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {LOCALES.map((l) => (
          <SelectItem key={l} value={l} data-testid={`locale-${l}`}>
            {t(`localeNames.${l}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ThemeToggle({ initial }: { initial: "light" | "dark" }) {
  const t = useTranslations("common.theme");
  const [theme, setTheme] = useState(initial);
  const next = theme === "dark" ? "light" : "dark";

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t("toggle")}
      title={t(next)}
      data-testid="theme-toggle"
      onClick={() => {
        document.documentElement.classList.toggle("dark", next === "dark");
        setTheme(next);
        void setThemeAction(next);
      }}
    >
      {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}
