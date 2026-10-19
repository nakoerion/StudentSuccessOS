import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { THEME_COOKIE } from "../i18n/config";
import { BrandMark } from "./brand";
import { LocaleSwitcher, ThemeToggle } from "./preferences";

export async function currentTheme(): Promise<"light" | "dark"> {
  return (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
}

/** Centered layout for signed-out / pre-tenant pages (sign in, join, picker). */
export async function CenteredShell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  const theme = await currentTheme();
  const t = await getTranslations("common");
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight">{t("appName")}</span>
        </div>
        <div className="flex items-center gap-2">
          {aside}
          <LocaleSwitcher />
          <ThemeToggle initial={theme} />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-12">{children}</main>
    </div>
  );
}
