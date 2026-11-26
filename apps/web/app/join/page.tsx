import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@ssos/ui";
import { withTenant } from "@ssos/db";
import { BookOpen, CircleX, Clock, GraduationCap, School, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CenteredShell } from "../../components/shell";
import { SignOutButton } from "../../components/sign-out-button";
import { CLAIMABLE_ROLES, lookupCode } from "../../lib/join";
import { ownRejectedClaims } from "../../lib/join-claims";
import { getMembershipRows, getMemberships, requireUser } from "../../lib/session";
import { landingPath, resolveLanding } from "../../lib/tenancy";
import { claimRoleAction, submitCodeAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("join");
  return { title: t("title") };
}

const ROLE_ICONS = { student: GraduationCap, parent: Users, teacher: BookOpen } as const;
const ERRORS = { invalid_code: "invalidCode", code_used: "codeUsed", invalid_role: "invalidRole" } as const;

type SearchParams = Promise<{ code?: string; error?: string; another?: string; claimed?: string }>;

export default async function JoinPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const t = await getTranslations("join");
  const tRoles = await getTranslations("roles");
  const errorKey = sp.error && sp.error in ERRORS ? ERRORS[sp.error as keyof typeof ERRORS] : null;

  const memberships = await getMemberships(user.id);
  // An approved claim: the next visit to /join lands in the school.
  if (!sp.code && !sp.another && !sp.error && !sp.claimed) {
    const landing = resolveLanding(await getMembershipRows(user.id));
    if (landing.kind === "tenant" || landing.kind === "picker") redirect(landingPath(landing));
  }
  const pending = memberships.filter((m) => m.pendingRoles.length > 0 && m.activeRoles.length === 0);
  // Refused claims (and nothing else waiting or granted there): say so, with the reason given.
  const rejected =
    pending.length > 0
      ? []
      : await Promise.all(
          memberships
            .filter((m) => m.rejectedRoles.length > 0 && m.activeRoles.length === 0 && m.pendingRoles.length === 0)
            .map(async (m) => ({
              school: m,
              claims: await withTenant(m.tenantId, (tx) => ownRejectedClaims(tx, m.personId), { userId: user.id }),
            })),
        );
  const found = sp.code ? await lookupCode(sp.code) : null;

  let body;
  if (found?.kind === "join") {
    body = (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-brand-subtle text-brand-subtle-foreground">
            <School className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">{t("chooseTitle", { school: found.name })}</CardTitle>
          <CardDescription>{t("chooseSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={claimRoleAction} className="flex flex-col gap-4">
            <input type="hidden" name="code" value={sp.code} />
            {errorKey ? <p role="alert" className="text-sm text-danger">{t(errorKey)}</p> : null}
            <fieldset className="grid gap-2">
              <legend className="sr-only">{t("chooseSubtitle")}</legend>
              {CLAIMABLE_ROLES.map((role, i) => {
                const Icon = ROLE_ICONS[role];
                return (
                  <label
                    key={role}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/60 has-[:checked]:border-brand has-[:checked]:bg-brand-subtle/60"
                  >
                    <input
                      type="radio"
                      name="role"
                      value={role}
                      defaultChecked={i === 0}
                      className="size-4 accent-[var(--brand)]"
                      data-testid={`role-${role}`}
                    />
                    <Icon className="size-5 text-muted-foreground" aria-hidden />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{tRoles(role)}</span>
                      <span className="text-xs text-muted-foreground">{t(`roleHint.${role}`)}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="flex items-center justify-between gap-2">
              <Button asChild variant="ghost">
                <Link href="/join?another=1">{t("differentCode")}</Link>
              </Button>
              <Button type="submit">{t("request")}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  } else if (pending.length > 0 && !sp.another && !sp.code) {
    body = (
      <Card data-testid="pending-approval">
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-warn-subtle text-warn-foreground">
            <Clock className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">{t("pendingTitle")}</CardTitle>
          <CardDescription>{t("pendingNext")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pending.map((m) => (
            <div key={m.tenantId} className="rounded-lg border border-border p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">{m.name}</span>
                <Badge variant="warn">{t("pendingTitle")}</Badge>
              </div>
              <p className="text-muted-foreground">
                {t("pendingBody", {
                  school: m.name,
                  role: m.pendingRoles.map((r) => tRoles(r)).join(", "),
                })}
              </p>
            </div>
          ))}
          <Button asChild variant="outline" className="self-start">
            <Link href="/join?another=1">{t("joinAnother")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  } else if (rejected.length > 0 && !sp.another && !sp.code) {
    body = (
      <Card data-testid="claim-rejected">
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-danger-subtle text-danger-foreground">
            <CircleX className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">{t("rejectedTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rejected.map(({ school, claims }) => (
            <div key={school.tenantId} className="rounded-lg border border-border p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">{school.name}</span>
                <Badge variant="danger">{t("rejectedTitle")}</Badge>
              </div>
              {claims.map((c) => (
                <div key={c.roleKey} className="flex flex-col gap-1">
                  <p className="text-muted-foreground">{t("rejectedBody", { school: school.name, role: tRoles(c.roleKey) })}</p>
                  {c.reason ? (
                    <p dir="auto" data-testid="rejected-reason">
                      {t("rejectedReason", { reason: c.reason })}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
          <Button asChild className="self-start">
            <Link href="/join?another=1" data-testid="claim-again">
              {t("claimAgain")}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  } else {
    const shownError = errorKey ?? (found && found.kind !== "invitation" ? ERRORS.invalid_code : null);
    body = (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-brand-subtle text-brand-subtle-foreground">
            <School className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={submitCodeAction} className="flex flex-col gap-3">
            <Label htmlFor="code">{t("codeLabel")}</Label>
            <Input
              id="code"
              name="code"
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder={t("codePlaceholder")}
              className="font-mono uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal"
              aria-invalid={shownError ? true : undefined}
              required
            />
            {shownError ? <p role="alert" className="text-sm text-danger">{t(shownError)}</p> : null}
            <Button type="submit" className="mt-1">
              {t("continue")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <CenteredShell aside={<SignOutButton compact />}>
      <div className="flex w-full max-w-md flex-col gap-4">
        {body}
        <p className="text-center text-xs text-muted-foreground" dir="auto">
          {(await getTranslations("common"))("signedInAs", { email: user.email })}
        </p>
      </div>
    </CenteredShell>
  );
}
