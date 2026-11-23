"use client";

import { Button } from "@ssos/ui";
import { AlertTriangle, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { StatePanel } from "../../../components/page";

/** Error state inside the shell: what happened and what to do next — never a stack trace. */
export default function TenantError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("shell.error");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatePanel
      testId="page-error"
      tone="watch"
      icon={<AlertTriangle className="size-5" aria-hidden />}
      title={t("title")}
      body={error.digest ? `${t("body")} (${error.digest})` : t("body")}
      action={
        <Button type="button" variant="outline" onClick={reset}>
          <RotateCw aria-hidden />
          {t("retry")}
        </Button>
      }
    />
  );
}
