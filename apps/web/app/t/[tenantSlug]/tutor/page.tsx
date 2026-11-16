import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { TutorChat, TutorUnavailable } from "../../../../components/tutor-chat";
import { canUseTutor } from "../../../../lib/access";
import { createAiClient } from "../../../../lib/ai/client";
import { loadTutorSubjects } from "../../../../lib/ai/tutor";
import { requireTenant } from "../../../../lib/session";

type Params = Promise<{ tenantSlug: string }>;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { membership } = await requireTenant((await params).tenantSlug);
  const t = await getTranslations("tutor");
  return { title: `${t("title")} · ${membership.name}` };
}

export default async function TutorPage({ params }: { params: Params }) {
  const { tenantSlug } = await params;
  const { membership, viewer, db } = await requireTenant(tenantSlug);
  if (!canUseTutor(viewer)) notFound();
  const t = await getTranslations("tutor");

  const [subjects, reachable] = await Promise.all([
    db((tx) => loadTutorSubjects(tx, membership.personId)),
    createAiClient(membership.tenantId).ping(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="tutor-title">
          {t("title")}
        </h1>
        <p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
      </div>
      {!reachable ? (
        <TutorUnavailable />
      ) : subjects.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-muted-foreground" data-testid="tutor-no-subjects">
          {t("noSubjects")}
        </p>
      ) : (
        <TutorChat
          tenantSlug={tenantSlug}
          subjects={subjects.map((s) => ({ courseId: s.courseId, label: s.courseName }))}
        />
      )}
    </div>
  );
}
