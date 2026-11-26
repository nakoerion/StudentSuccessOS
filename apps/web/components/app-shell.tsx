"use client";

/**
 * AppShell — the one persistent frame for every /t/<school>/… route: a start-side sidebar
 * (full on wide screens, icon-only rail on tablets, a drawer on phones) and a top bar with
 * the breadcrumb, the signed-in person and their role, and the preference controls.
 *
 * The nav is role-aware: the server decides which items exist (permission keys), and this
 * component only renders what it is given — a viewer never sees a link that would 404.
 * Logical properties only (start/end, ms/me, ps/pe), so the whole shell mirrors in Arabic.
 */
import { cn } from "@ssos/ui";
import { ArrowLeftRight, ChevronRight, Gauge, GraduationCap, Grid3x3, Inbox, LayoutDashboard, Menu, PanelLeftClose, PanelLeftOpen, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";

import { BrandMark } from "./brand";

export type NavKey = "dashboard" | "people" | "inbox" | "mastery" | "tutor" | "aiUsage";

const NAV: { key: NavKey; path: string; icon: typeof Inbox; also?: string[] }[] = [
  { key: "dashboard", path: "", icon: LayoutDashboard },
  { key: "people", path: "/people", icon: Users, also: ["/students"] },
  { key: "inbox", path: "/inbox", icon: Inbox },
  { key: "mastery", path: "/mastery", icon: Grid3x3 },
  { key: "tutor", path: "/tutor", icon: GraduationCap },
  { key: "aiUsage", path: "/ai-usage", icon: Gauge },
];

const TESTID: Record<NavKey, string> = {
  dashboard: "nav-dashboard",
  people: "nav-people",
  inbox: "nav-inbox",
  mastery: "nav-mastery",
  tutor: "nav-tutor",
  aiUsage: "nav-ai-usage",
};

const COLLAPSE_KEY = "ssos.sidebar.collapsed";

export interface AppShellProps {
  slug: string;
  school: { name: string; country: string };
  person: { name: string; roles: string[] };
  /** Nav items the viewer may open (decided on the server from permission keys). */
  nav: NavKey[];
  /** Counts shown on nav items (e.g. join claims waiting on People); absent = no badge. */
  badges?: Partial<Record<NavKey, { count: number; label: string }>>;
  canSwitchSchool: boolean;
  /** Language switcher, theme toggle, sign out (server-rendered client controls). */
  controls: ReactNode;
  children: ReactNode;
}

export function AppShell({ slug, school, person, nav, badges = {}, canSwitchSchool, controls, children }: AppShellProps) {
  const t = useTranslations("shell");
  const tNav = useTranslations("nav");
  const pathname = usePathname();
  const base = `/t/${slug}`;
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  };

  const items = NAV.filter((n) => nav.includes(n.key)).map((n) => {
    const href = `${base}${n.path}`;
    const active = n.path === "" ? pathname === base : [n.path, ...(n.also ?? [])].some((p) => pathname.startsWith(`${base}${p}`));
    return { ...n, href, active, label: tNav(n.key) };
  });
  const current = items.find((i) => i.active && i.key !== "dashboard") ?? null;
  const detail = current && pathname !== current.href && pathname.startsWith(`${base}/students/`) ? t("crumbs.student") : null;

  const sidebar = (rail: boolean) => (
    <div className="flex h-full flex-col gap-2">
      <div className={cn("flex items-center gap-3 border-b border-border px-3 py-3", rail && "justify-center px-2")}>
        <Link href={base} className="flex min-w-0 items-center gap-3" title={school.name}>
          <BrandMark />
          {rail ? null : (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold" data-testid="school-name">
                {school.name}
              </span>
              <span className="truncate text-xs text-muted-foreground" data-testid="school-country">
                {school.country}
              </span>
            </span>
          )}
        </Link>
        {canSwitchSchool && !rail ? (
          <Link
            href="/schools"
            title={tNav("switchSchool")}
            aria-label={tNav("switchSchool")}
            className="ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            data-testid="school-switcher"
          >
            <ArrowLeftRight className="size-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      <nav aria-label={t("mainNav")} className="flex flex-1 flex-col gap-1 px-2">
        {items.map(({ key, href, label, icon: Icon, active }) => (
          <Link
            key={key}
            href={href}
            aria-current={active ? "page" : undefined}
            title={rail ? label : undefined}
            data-testid={TESTID[key]}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
              active && "bg-brand-subtle text-brand-subtle-foreground hover:bg-brand-subtle hover:text-brand-subtle-foreground",
              rail && "justify-center px-0",
            )}
          >
            <span className="relative shrink-0">
              <Icon className="size-4" aria-hidden />
              {rail && badges[key] ? <span className="absolute -end-1.5 -top-1.5 size-2.5 rounded-full bg-brand ring-2 ring-surface" aria-hidden /> : null}
            </span>
            {rail ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
            {badges[key] ? (
              rail ? (
                <span className="sr-only">{badges[key].label}</span>
              ) : (
                <span
                  className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-semibold text-brand-foreground"
                  title={badges[key].label}
                  aria-label={badges[key].label}
                  data-testid={`${TESTID[key]}-badge`}
                >
                  {badges[key].count}
                </span>
              )
            ) : null}
          </Link>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar: icon rail on md, full (collapsible) on lg; hidden on phones (drawer instead). */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 border-e border-border bg-surface transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-16 lg:w-64",
        )}
        data-testid="app-sidebar"
      >
        <div className={cn("h-full", collapsed ? "block" : "block lg:hidden")}>{sidebar(true)}</div>
        <div className={cn("h-full", collapsed ? "hidden" : "hidden lg:block")}>{sidebar(false)}</div>
      </aside>

      {/* Drawer on phones. */}
      {drawer ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t("mainNav")}>
          <button type="button" className="absolute inset-0 bg-foreground/30" aria-label={t("closeMenu")} onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 start-0 w-72 max-w-[85vw] border-e border-border bg-surface shadow-xl" data-testid="app-drawer">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label={t("closeMenu")}
              className="absolute end-2 top-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" aria-hidden />
            </button>
            {sidebar(false)}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
            <button
              type="button"
              onClick={() => setDrawer(true)}
              aria-label={t("openMenu")}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted md:hidden"
              data-testid="drawer-open"
            >
              <Menu className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              className="hidden size-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted lg:inline-flex"
              data-testid="sidebar-toggle"
            >
              {collapsed ? <PanelLeftOpen className="size-4 rtl:-scale-x-100" aria-hidden /> : <PanelLeftClose className="size-4 rtl:-scale-x-100" aria-hidden />}
            </button>
            <nav aria-label={t("breadcrumb")} className="min-w-0 flex-1" data-testid="breadcrumb">
              <ol className="flex min-w-0 items-center gap-1.5 text-sm">
                <li className={cn("truncate", current ? "hidden text-muted-foreground sm:block" : "font-medium")}>
                  {current ? (
                    <Link href={base} className="hover:text-foreground">
                      {school.name}
                    </Link>
                  ) : (
                    <span aria-current="page">{tNav("dashboard")}</span>
                  )}
                </li>
                {current ? (
                  <>
                    <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground sm:block rtl:rotate-180" aria-hidden />
                    <li className={cn("truncate", detail ? "text-muted-foreground" : "font-medium")}>
                      {detail ? (
                        <Link href={current.href} className="hover:text-foreground">
                          {current.label}
                        </Link>
                      ) : (
                        <span aria-current="page">{current.label}</span>
                      )}
                    </li>
                    {detail ? (
                      <>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
                        <li className="truncate font-medium" aria-current="page">
                          {detail}
                        </li>
                      </>
                    ) : null}
                  </>
                ) : null}
              </ol>
            </nav>
            <div className="hidden min-w-0 flex-col items-end leading-tight lg:flex" data-testid="signed-in-person">
              <span className="max-w-48 truncate text-sm font-medium">{person.name}</span>
              <span className="truncate text-xs text-muted-foreground" data-testid="user-roles">
                {person.roles.join(" · ")}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">{controls}</div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
