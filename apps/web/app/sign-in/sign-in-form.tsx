"use client";

import { Button, Input, Label } from "@ssos/ui";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { signInAction, type SignInState } from "./actions";

export function SignInForm() {
  const t = useTranslations("signIn");
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, { error: null, email: "" });

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("invalid")}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          dir="ltr"
          required
          defaultValue={state.email}
          aria-invalid={state.error ? true : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          required
          aria-invalid={state.error ? true : undefined}
        />
      </div>
      <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
