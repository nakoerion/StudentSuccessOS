import { getSessionUser } from "@ssos/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { LandingPage } from "../components/landing";
import { isLocale } from "../i18n/config";
import { getMembershipRows } from "../lib/session";
import { landingPath, resolveLanding } from "../lib/tenancy";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing.hero");
  return { description: t("subtitle") };
}

/**
 * Entry point. Signed-in users are routed by their memberships (0 / 1 / many);
 * signed-out visitors see the public landing page.
 */
export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect(landingPath(resolveLanding(await getMembershipRows(user.id))));
  const raw = await getLocale();
  return <LandingPage locale={isLocale(raw) ? raw : "en"} />;
}
