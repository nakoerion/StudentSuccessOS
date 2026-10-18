import {
  Badge,
  Button,
  Card,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TabsNav,
  TabsNavItem,
} from "@ssos/ui";
import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { rosterScope } from "../../../../lib/access";
import { listRoster, parseRosterFilter, type RosterFilter } from "../../../../lib/roster";
import { requireTenant } from "../../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;
type SearchParams = Promise<{ role?: string; q?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("people");
  return { title: `${t("title")} · ${membership.name}` };
}

const TABS: RosterFilter[] = ["all", "student", "teacher", "parent"];
const ROLE_BADGE = { student: "default", teacher: "success", parent: "warn" } as const;

export default async function PeoplePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { tenantSlug } = await params;
  const sp = await searchParams;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  const t = await getTranslations("people");
  const tRoles = await getTranslations("roles");
  const tRel = await getTranslations("relationship");

  const scope = rosterScope(viewer);
  const isParentView = scope.kind === "own_children";
  const filter = isParentView ? "student" : parseRosterFilter(sp.role);
  const q = (sp.q ?? "").slice(0, 100);
  // Server-side: the scope goes into the SQL WHERE; nothing is filtered in the browser.
  const rows = await db((tx) => listRoster(tx, scope, { filter, search: q }));

  const base = `/t/${tenantSlug}/people`;
  const hrefFor = (role: RosterFilter) => {
    const params = new URLSearchParams();
    if (role !== "all") params.set("role", role);
    if (q) params.set("q", q);
    const s = params.toString();
    return s ? `${base}?${s}` : base;
  };
  const showGuardians = filter === "all" || filter === "student";
  const showChildren = !isParentView && (filter === "all" || filter === "parent");
  const relLabel = (r: string) => (["mother", "father", "guardian"].includes(r) ? tRel(r) : r);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">
          {isParentView ? t("parentSubtitle") : t("subtitle", { school: membership.name })}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isParentView ? (
          <span />
        ) : (
          <TabsNav aria-label={t("title")} data-testid="role-tabs">
            {TABS.map((role) => (
              <TabsNavItem key={role} active={filter === role}>
                <Link href={hrefFor(role)} data-testid={`tab-${role}`}>
                  {t(`tabs.${role}`)}
                </Link>
              </TabsNavItem>
            ))}
          </TabsNav>
        )}
        <form action={base} method="get" className="flex items-center gap-2" role="search">
          {filter !== "all" && !isParentView ? <input type="hidden" name="role" value={filter} /> : null}
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              name="q"
              type="search"
              defaultValue={q}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
              className="ps-8"
              data-testid="people-search"
            />
          </div>
          <Button type="submit" variant="secondary">
            {t("search")}
          </Button>
          {q ? (
            <Button asChild variant="ghost">
              <Link href={hrefFor(filter)}>{t("clear")}</Link>
            </Button>
          ) : null}
        </form>
      </div>

      <Card className="overflow-hidden">
        <Table data-testid="people-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.role")}</TableHead>
              <TableHead>{t("columns.class")}</TableHead>
              {showGuardians ? <TableHead>{t("columns.guardians")}</TableHead> : null}
              {showChildren ? <TableHead>{t("columns.children")}</TableHead> : null}
              <TableHead className="text-end">{t("columns.id")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id} data-testid="person-row">
                  <TableCell className="font-medium">{p.displayName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {p.roles.map((r) => (
                        <Badge key={r} variant={ROLE_BADGE[r as keyof typeof ROLE_BADGE] ?? "neutral"}>
                          {tRoles(r)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.units.join(", ") || t("none")}</TableCell>
                  {showGuardians ? (
                    <TableCell className="text-muted-foreground">
                      {p.guardians.length === 0
                        ? t("none")
                        : p.guardians.map((g) => (
                            <span key={g.id} className="block">
                              {g.displayName} <span className="text-xs">({relLabel(g.relationship)})</span>
                            </span>
                          ))}
                    </TableCell>
                  ) : null}
                  {showChildren ? (
                    <TableCell className="text-muted-foreground">
                      {p.children.length === 0
                        ? t("none")
                        : p.children.map((c) => (
                            <span key={c.id} className="block">
                              {c.displayName}
                            </span>
                          ))}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-end font-mono text-xs text-muted-foreground" dir="ltr">
                    {p.externalRef ?? t("none")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-sm text-muted-foreground" data-testid="people-count">
        {t("count", { count: rows.length })}
      </p>
    </div>
  );
}
