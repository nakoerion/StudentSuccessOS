import { Badge, Card, CardDescription, CardHeader, CardTitle } from "@ssos/ui";
import { ChevronRight, School } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { CenteredShell } from "../../components/shell";
import { SignOutButton } from "../../components/sign-out-button";
import { getMemberships, requireUser } from "../../lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("schools");
  return { title: t("title") };
}

/** School picker for users with more than one active membership. */
export default async function SchoolsPage() {
  const user = await requireUser();
  const t = await getTranslations("schools");
  const tRoles = await getTranslations("roles");
  const schools = (await getMemberships(user.id)).filter((m) => m.activeRoles.length > 0);

  return (
    <CenteredShell aside={<SignOutButton compact />}>
      <div className="flex w-full max-w-md flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {schools.map((s) => (
          <Link key={s.tenantId} href={`/t/${s.slug}`} className="group">
            <Card className="transition-colors group-hover:border-brand">
              <CardHeader className="flex-row items-center gap-3">
                <School className="size-5 text-muted-foreground" aria-hidden />
                <div className="flex flex-1 flex-col gap-1">
                  <CardTitle>{s.name}</CardTitle>
                  <CardDescription className="flex gap-1">
                    {s.activeRoles.map((r) => (
                      <Badge key={r} variant="neutral">
                        {tRoles(r)}
                      </Badge>
                    ))}
                  </CardDescription>
                </div>
                <ChevronRight className="size-4 text-muted-foreground rtl:-scale-x-100" aria-label={t("open")} />
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </CenteredShell>
  );
}
