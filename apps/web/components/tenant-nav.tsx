"use client";

import { cn } from "@ssos/ui";
import { Grid3x3, GraduationCap, Inbox, LayoutDashboard, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

export function TenantNav({ slug, showInbox = false, showTutor = false, showMastery = false }: { slug: string; showInbox?: boolean; showTutor?: boolean; showMastery?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const base = `/t/${slug}`;
  const items = [
    { href: base, label: t("dashboard"), icon: LayoutDashboard, active: pathname === base },
    {
      href: `${base}/people`,
      label: t("people"),
      icon: Users,
      active: pathname.startsWith(`${base}/people`) || pathname.startsWith(`${base}/students`),
    },
    ...(showInbox ? [{ href: `${base}/inbox`, label: t("inbox"), icon: Inbox, active: pathname.startsWith(`${base}/inbox`) }] : []),
    ...(showMastery ? [{ href: `${base}/mastery`, label: t("mastery"), icon: Grid3x3, active: pathname.startsWith(`${base}/mastery`) }] : []),
    ...(showTutor ? [{ href: `${base}/tutor`, label: t("tutor"), icon: GraduationCap, active: pathname.startsWith(`${base}/tutor`) }] : []),
  ];
  return (
    <nav className="flex items-center gap-1" aria-label={t("dashboard")}>
      {items.map(({ href, label, icon: Icon, active }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          data-testid={`nav-${href === base ? "dashboard" : href.slice(base.length + 1)}`}
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            active && "bg-muted text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
