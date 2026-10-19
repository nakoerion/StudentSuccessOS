"use client";

import { cn } from "@ssos/ui";
import { LayoutDashboard, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

export function TenantNav({ slug }: { slug: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const base = `/t/${slug}`;
  const items = [
    { href: base, label: t("dashboard"), icon: LayoutDashboard, active: pathname === base },
    { href: `${base}/people`, label: t("people"), icon: Users, active: pathname.startsWith(`${base}/people`) },
  ];
  return (
    <nav className="flex items-center gap-1" aria-label={t("dashboard")}>
      {items.map(({ href, label, icon: Icon, active }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
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
