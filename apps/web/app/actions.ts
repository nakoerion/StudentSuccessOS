"use server";

import { signOutUser } from "@ssos/auth";
import { cookies } from "next/headers";

import { isLocale, LOCALE_COOKIE, THEME_COOKIE } from "../i18n/config";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Persist the user's language choice; the page re-renders in that locale. */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
}

export async function setThemeAction(theme: string): Promise<void> {
  if (theme !== "light" && theme !== "dark") return;
  (await cookies()).set(THEME_COOKIE, theme, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
}

export async function signOutAction(): Promise<void> {
  await signOutUser("/sign-in");
}
