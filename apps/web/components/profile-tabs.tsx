"use client";

/**
 * Student profile frame: a sticky header (name, class, risk, track and the one next-action
 * button) over tabs — Overview / Risk / Track history / Alerts — so nothing is a page-long
 * scroll away. Tab panels are server-rendered and kept mounted; only visibility changes.
 */
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@ssos/ui";
import { ArrowRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

export type ProfileTab = "overview" | "risk" | "tracks" | "alerts";

export function ProfileTabs({
  header,
  nextAction,
  panels,
  counts,
}: {
  header: ReactNode;
  nextAction: { tab: ProfileTab; anchor?: string; label: string } | null;
  panels: Record<ProfileTab, ReactNode>;
  counts: Partial<Record<ProfileTab, number>>;
}) {
  const t = useTranslations("success.profile.tabs");
  const locale = useLocale();
  const [tab, setTab] = useState<ProfileTab>("overview");
  const tabs: ProfileTab[] = ["overview", "risk", "tracks", "alerts"];

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as ProfileTab)} dir={locale === "ar" ? "rtl" : "ltr"} className="flex flex-col gap-5">
      <div className="sticky top-14 z-20 -mx-4 flex flex-col gap-3 border-b border-border bg-background/95 px-4 pb-3 pt-2 backdrop-blur sm:-mx-6 sm:px-6" data-testid="profile-header">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">{header}</div>
          {nextAction ? (
            <Button
              type="button"
              data-testid="profile-next-action"
              onClick={() => {
                setTab(nextAction.tab);
                if (nextAction.anchor) {
                  requestAnimationFrame(() => document.getElementById(nextAction.anchor!)?.scrollIntoView({ behavior: "smooth", block: "start" }));
                }
              }}
            >
              {nextAction.label}
              <ArrowRight className="rtl:rotate-180" aria-hidden />
            </Button>
          ) : null}
        </div>
        <TabsList className="w-fit max-w-full overflow-x-auto">
          {tabs.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`profile-tab-${k}`}>
              {t(k)}
              {counts[k] ? <span className="rounded-full bg-brand-subtle px-1.5 text-xs tabular-nums text-brand-subtle-foreground">{counts[k]}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((k) => (
        <TabsContent key={k} value={k} forceMount className="data-[state=inactive]:hidden">
          {panels[k]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
