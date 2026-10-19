import "./globals.css";

import type { Metadata } from "next";
import { Inter, Noto_Sans_Arabic } from "next/font/google";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { dirFor, isLocale, THEME_COOKIE } from "../i18n/config";

// Inter covers Latin incl. Albanian diacritics (ë, ç); Noto Sans Arabic covers Arabic.
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter", display: "swap" });
const arabic = Noto_Sans_Arabic({ subsets: ["arabic"], variable: "--font-arabic", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: { default: t("title"), template: `%s · ${t("title")}` }, description: t("description") };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const rawLocale = await getLocale();
  const locale = isLocale(rawLocale) ? rawLocale : "en";
  const messages = await getMessages();
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";

  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      className={`${inter.variable} ${arabic.variable} ${theme === "dark" ? "dark" : ""}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
