import { getTranslations } from "next-intl/server";

import { Skeleton } from "../../../../../components/page";

export default async function Loading() {
  const t = await getTranslations("claims");
  return (
    <div className="flex flex-col gap-6" role="status" aria-label={t("loading")}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
