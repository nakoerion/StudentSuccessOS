import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

import { getMemberships } from "../lib/session";
import { getSessionUser } from "@ssos/auth";
import { chooseLocale, LOCALE_COOKIE, type Locale } from "./config";

/** `/t/<slug>/...` -> slug (the middleware forwards the pathname as a header). */
function tenantSlugFromPath(pathname: string | null): string | null {
  const m = pathname?.match(/^\/t\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export async function resolveRequestLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const cookie = cookieStore.get(LOCALE_COOKIE)?.value ?? null;
  const acceptLanguage = headerStore.get("accept-language");
  if (cookie) return chooseLocale({ cookie, acceptLanguage });

  const user = await getSessionUser();
  let tenantDefault: string | null = null;
  if (user) {
    const groups = await getMemberships(user.id);
    const slug = tenantSlugFromPath(headerStore.get("x-ssos-pathname"));
    // Tenant in the URL wins; otherwise a user with exactly one school gets its default.
    const current = slug ? groups.find((g) => g.slug === slug) : groups.length === 1 ? groups[0] : undefined;
    tenantDefault = current?.defaultLocale ?? null;
  }
  return chooseLocale({ tenantDefault, account: user?.locale, acceptLanguage });
}

export default getRequestConfig(async () => {
  const locale = await resolveRequestLocale();
  const messages = (await import(`../messages/${locale}.json`)) as { default: Record<string, unknown> };
  return { locale, messages: messages.default };
});
