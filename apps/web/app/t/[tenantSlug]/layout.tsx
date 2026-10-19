import { Badge } from "@ssos/ui";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { BrandMark } from "../../../components/brand";
import { LocaleSwitcher, ThemeToggle } from "../../../components/preferences";
import { currentTheme } from "../../../components/shell";
import { SignOutButton } from "../../../components/sign-out-button";
import { TenantNav } from "../../../components/tenant-nav";
import { getMemberships, requireTenant } from "../../../lib/session";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const { user, membership, viewer } = await requireTenant(tenantSlug);
  const t = await getTranslations();
  const theme = await currentTheme();
  const schoolCount = (await getMemberships(user.id)).filter((m) => m.activeRoles.length > 0).length;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href={`/t/${tenantSlug}`} className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold" data-testid="school-name">
                {membership.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">{t("common.appName")}</span>
            </span>
          </Link>
          <div className="hidden md:block">
            <TenantNav slug={tenantSlug} />
          </div>
          <div className="ms-auto flex items-center gap-2">
            <div className="hidden items-center gap-1 sm:flex" data-testid="user-roles">
              {viewer.roles.map((r) => (
                <Badge key={r}>{t(`roles.${r}`)}</Badge>
              ))}
            </div>
            {schoolCount > 1 ? (
              <Link
                href="/schools"
                title={t("nav.switchSchool")}
                aria-label={t("nav.switchSchool")}
                className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <ArrowLeftRight className="size-4" aria-hidden />
              </Link>
            ) : null}
            <LocaleSwitcher />
            <ThemeToggle initial={theme} />
            <SignOutButton compact />
          </div>
        </div>
        <div className="border-t border-border px-4 py-1.5 md:hidden">
          <TenantNav slug={tenantSlug} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
