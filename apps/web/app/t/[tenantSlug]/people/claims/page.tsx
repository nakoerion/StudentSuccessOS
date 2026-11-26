import { Button } from "@ssos/ui";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "../../../../../components/page";
import { PendingClaims } from "../../../../../components/pending-claims";
import { canApproveClaims, listPendingClaims } from "../../../../../lib/join-claims";
import { requireTenant } from "../../../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("claims");
  return { title: `${t("title")} · ${membership.name}` };
}

export default async function PendingClaimsPage({ params }: { params: Params }) {
  const { tenantSlug } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  // Enforced here, not only by hiding the link: anyone who cannot approve gets a real 404.
  if (!canApproveClaims(viewer)) notFound();
  const t = await getTranslations("claims");
  const claims = await db((tx) => listPendingClaims(tx));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { school: membership.name })}
        testId="claims-title"
        actions={
          <Button asChild variant="ghost">
            <Link href={`/t/${tenantSlug}/people`}>
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              {t("back")}
            </Link>
          </Button>
        }
      />
      <PendingClaims
        tenantSlug={tenantSlug}
        claims={claims.map((c) => ({ id: c.id, name: c.name, email: c.email, roleKey: c.roleKey, claimedAt: c.claimedAt.toISOString() }))}
      />
      <p className="text-sm text-muted-foreground" data-testid="claims-count">
        {t("count", { count: claims.length })}
      </p>
    </div>
  );
}
