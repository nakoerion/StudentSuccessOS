import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { AppShell, type NavKey } from "../../../components/app-shell";
import { LocaleSwitcher, ThemeToggle } from "../../../components/preferences";
import { currentTheme } from "../../../components/shell";
import { SignOutButton } from "../../../components/sign-out-button";
import { canUseTutor, canViewAiUsage, canViewMastery, canViewSuccess, rosterScope } from "../../../lib/access";
import { canApproveClaims, countPendingClaims } from "../../../lib/join-claims";
import { getMemberships, requireTenant } from "../../../lib/session";

/** Country display name from the ISO code, in the viewer's language (data, not a branch). */
function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const { user, membership, viewer, db } = await requireTenant(tenantSlug);
  const t = await getTranslations();
  const locale = await getLocale();
  const theme = await currentTheme();
  const schoolCount = (await getMemberships(user.id)).filter((m) => m.activeRoles.length > 0).length;
  const person = await db((tx) => tx.person.findUnique({ where: { id: viewer.personId }, select: { displayName: true } }));

  // Role-aware nav: only what the viewer can open. Every page re-checks on the server.
  const nav: NavKey[] = ["dashboard"];
  if (rosterScope(viewer).kind !== "none") nav.push("people");
  if (canViewSuccess(viewer)) nav.push("inbox");
  if (canViewMastery(viewer)) nav.push("mastery");
  if (canUseTutor(viewer)) nav.push("tutor");
  if (canViewAiUsage(viewer)) nav.push("aiUsage");
  // People carries a count of join claims waiting, for those who can approve them.
  const pendingClaims = canApproveClaims(viewer) ? await db((tx) => countPendingClaims(tx)) : 0;

  return (
    <AppShell
      slug={tenantSlug}
      school={{ name: membership.name, country: countryName(membership.countryCode, locale) }}
      person={{ name: person?.displayName ?? user.email ?? "", roles: viewer.roles.map((r) => t(`roles.${r}`)) }}
      nav={nav}
      badges={pendingClaims > 0 ? { people: { count: pendingClaims, label: t("claims.count", { count: pendingClaims }) } } : {}}
      canSwitchSchool={schoolCount > 1}
      controls={
        <>
          <LocaleSwitcher />
          <ThemeToggle initial={theme} />
          <SignOutButton compact />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
