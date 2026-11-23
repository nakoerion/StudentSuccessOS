import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionInbox } from "../../../../components/action-inbox";
import { PageHeader } from "../../../../components/page";
import { canViewSuccess } from "../../../../lib/access";
import { requireTenant } from "../../../../lib/session";
import { loadInboxCards, makeDateFormatters, tenantTimeZone } from "../../../../lib/success";

type Params = Promise<{ tenantSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("success.inbox");
  return { title: `${t("title")} · ${membership.name}` };
}

export default async function InboxPage({ params }: { params: Params }) {
  const { tenantSlug } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  if (!canViewSuccess(viewer)) notFound();
  const t = await getTranslations("success.inbox");
  const locale = await getLocale();

  const cards = await db(async (tx) => {
    const fmt = makeDateFormatters(locale, await tenantTimeZone(tx, membership.tenantId));
    return loadInboxCards(tx, { tenantId: membership.tenantId, viewer, fmt });
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} testId="inbox-title" />
      <ActionInbox tenantSlug={tenantSlug} cards={cards} keyboard />
    </div>
  );
}
