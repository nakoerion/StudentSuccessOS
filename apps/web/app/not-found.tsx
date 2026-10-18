import { Button } from "@ssos/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">{t("notFoundTitle")}</h1>
      <p className="max-w-sm text-muted-foreground">{t("notFoundBody")}</p>
      <Button asChild className="mt-2">
        <Link href="/">{t("home")}</Link>
      </Button>
    </main>
  );
}
