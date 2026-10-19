import { Button } from "@ssos/ui";
import { LogOut } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { signOutAction } from "../app/actions";

export async function SignOutButton({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations("common");
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size={compact ? "icon" : "md"} aria-label={t("signOut")} data-testid="sign-out">
        <LogOut className="rtl:-scale-x-100" aria-hidden />
        {compact ? null : t("signOut")}
      </Button>
    </form>
  );
}
