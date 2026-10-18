import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ssos/ui";
import { ArrowRight, BookOpen, Clock, GraduationCap, LayoutGrid, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { rosterScope } from "../../../lib/access";
import { dashboardCounts, listRoster, pendingClaimsCount } from "../../../lib/roster";
import { requireTenant } from "../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("nav");
  return { title: `${t("dashboard")} · ${membership.name}` };
}

const CARDS = [
  { key: "students", icon: GraduationCap },
  { key: "teachers", icon: BookOpen },
  { key: "parents", icon: Users },
  { key: "classes", icon: LayoutGrid },
] as const;

export default async function DashboardPage({ params }: { params: Params }) {
  const { tenantSlug } = await params;
  const { user, membership, viewer, db } = await requireTenant(tenantSlug);
  const t = await getTranslations("dashboard");
  const tPeople = await getTranslations("people");
  const scope = rosterScope(viewer);
  const canManage = viewer.permissions.has("tenant.manage");

  const data = await db(async (tx) => ({
    counts: scope.kind === "all" ? await dashboardCounts(tx) : null,
    children: scope.kind === "own_children" ? await listRoster(tx, scope, { filter: "student" }) : [],
    pending: canManage ? await pendingClaimsCount(tx) : 0,
  }));
  const counts = data.counts;
  const firstName = (user.name ?? user.email).split(" ")[0];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="dashboard-title">
            {t("welcome", { name: firstName ?? "" })}
          </h1>
          <p className="mt-1 text-muted-foreground">{t("subtitle", { school: membership.name })}</p>
        </div>
        {scope.kind !== "none" ? (
          <Button asChild variant="outline">
            <Link href={`/t/${tenantSlug}/people`} data-testid="open-people">
              {t("viewRoster")}
              <ArrowRight className="rtl:-scale-x-100" aria-hidden />
            </Link>
          </Button>
        ) : null}
      </div>

      {canManage ? (
        <div
          className={
            data.pending > 0
              ? "flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-subtle px-4 py-3 text-sm text-warn-foreground"
              : "flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
          }
          data-testid="pending-claims"
        >
          <Clock className="size-4 shrink-0" aria-hidden />
          {t("pendingClaims", { count: data.pending })}
        </div>
      ) : null}

      {counts ? (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="summary-cards">
          {CARDS.map(({ key, icon: Icon }) => (
            <Card key={key}>
              <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
                <CardDescription className="font-medium text-foreground">{t(`cards.${key}`)}</CardDescription>
                <span className="flex size-8 items-center justify-center rounded-md bg-brand-subtle text-brand-subtle-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tabular-nums" data-testid={`count-${key}`}>
                  {counts[key]}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t(`cardHint.${key}`)}</p>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {scope.kind === "own_children" ? (
        <section className="flex flex-col gap-3" data-testid="my-children">
          <div>
            <h2 className="text-lg font-semibold">{t("myChildren")}</h2>
            <p className="text-sm text-muted-foreground">{t("myChildrenSubtitle")}</p>
          </div>
          {data.children.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noChildren")}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.children.map((c) => (
                <Card key={c.id}>
                  <CardHeader className="flex-row items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand-subtle-foreground">
                      {initials(c.displayName)}
                    </span>
                    <div className="flex flex-col gap-1">
                      <CardTitle>{c.displayName}</CardTitle>
                      <CardDescription className="flex flex-wrap items-center gap-1.5">
                        {c.units.map((u) => (
                          <Badge key={u} variant="neutral">
                            {u}
                          </Badge>
                        ))}
                        <span className="font-mono text-xs" dir="ltr">
                          {c.externalRef ?? tPeople("none")}
                        </span>
                      </CardDescription>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {scope.kind === "none" ? (
        <Card>
          <CardContent className="pt-5 text-sm text-muted-foreground">{t("noAccess")}</CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase();
}
