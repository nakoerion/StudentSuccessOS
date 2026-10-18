import { getSessionUser } from "@ssos/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ssos/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CenteredShell } from "../../components/shell";
import { SignInForm } from "./sign-in-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signIn");
  return { title: t("submit") };
}

/** Demo logins (seeded, synthetic). Shown so reviewers can click through. */
const DEMO_ACCOUNTS = [
  "admin.tirane@demo.ssos.test",
  "teacher.tirane@demo.ssos.test",
  "parent.tirane@demo.ssos.test",
  "admin.abudhabi@demo.ssos.test",
  "parent.abudhabi@demo.ssos.test",
  "join@demo.ssos.test",
];

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/");
  const t = await getTranslations("signIn");
  const showDemo = process.env.SSOS_HIDE_DEMO_ACCOUNTS !== "1";

  return (
    <CenteredShell>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("tagline")}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("submit")}</CardTitle>
            <CardDescription>{t("subtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SignInForm />
          </CardContent>
        </Card>
        {showDemo ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">{t("demoTitle")}</p>
            <ul className="grid gap-0.5 font-mono" dir="ltr">
              {DEMO_ACCOUNTS.map((e) => (
                <li key={e} className="text-start">{e}</li>
              ))}
            </ul>
            <p className="mt-1.5">{t("demoPassword", { password: "Demo1234!" })}</p>
          </div>
        ) : null}
      </div>
    </CenteredShell>
  );
}
