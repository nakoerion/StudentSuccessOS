"use client";

/**
 * PendingClaims — the admin's list of people who asked to join with the school's join code.
 * Approve and Reject act in place with the action inbox's feel: the row leaves at once, a
 * toast offers Undo for UNDO_MS, and only then is the decision sent. Undo inside the window
 * never sends anything, so it never has to reverse a saved membership. If the server
 * refuses, the row comes back with the reason and whatever reason text was typed.
 * Logical properties only, so the layout mirrors in Arabic.
 */
import { Badge, Button, Card, Input, Label } from "@ssos/ui";
import { Check, Undo2, UserCheck, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { type ClaimActionResult, decideClaimAction } from "../app/t/[tenantSlug]/people/claims/actions";
import { createUndoQueue } from "../lib/undo-queue";
import { UNDO_MS } from "./action-inbox";
import { StatePanel } from "./page";

export interface PendingClaimView {
  id: string;
  name: string;
  email: string | null;
  roleKey: string;
  claimedAt: string;
}

type Decision = { claimId: string; name: string; roleKey: string; decision: "approve" | "reject"; reason?: string };
type ErrorCode = Extract<ClaimActionResult, { status: "error" }>["code"];

const ROLE_BADGE: Record<string, "default" | "success" | "warn" | "neutral"> = { student: "default", teacher: "success", parent: "warn" };

export function PendingClaims({ tenantSlug, claims }: { tenantSlug: string; claims: PendingClaimView[] }) {
  const t = useTranslations("claims");
  const tRoles = useTranslations("roles");
  const format = useFormatter();
  const [, rerender] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, ErrorCode>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const queue = useRef(
    createUndoQueue<Decision>({
      delayMs: UNDO_MS,
      onChange: () => rerender((n) => n + 1),
      commit: async (d) => {
        let result: ClaimActionResult;
        try {
          result = await decideClaimAction({ tenantSlug, claimId: d.claimId, decision: d.decision, ...(d.reason ? { reason: d.reason } : {}) });
        } catch {
          result = { status: "error", code: "unexpected" };
        }
        if (result.status === "ok") setDone((s) => new Set(s).add(d.claimId));
        else setErrors((e) => ({ ...e, [d.claimId]: result.code }));
      },
    }),
  ).current;

  // Leaving the page or hiding the tab sends what is still waiting, rather than losing it.
  useEffect(() => {
    const flush = () => void queue.flush();
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [queue]);

  const held = queue.pending();
  const heldIds = new Set(held.map((h) => h.item.claimId));
  const visible = claims.filter((c) => !done.has(c.id) && !heldIds.has(c.id));

  const decide = (c: PendingClaimView, decision: "approve" | "reject") => {
    const reason = decision === "reject" ? reasons[c.id]?.trim() : undefined;
    setErrors((e) => {
      const next = { ...e };
      delete next[c.id];
      return next;
    });
    setRejecting(null);
    queue.schedule({ claimId: c.id, name: c.name, roleKey: c.roleKey, decision, ...(reason ? { reason } : {}) });
  };

  return (
    <div className="flex flex-col gap-4">
      {visible.length === 0 && held.length === 0 ? (
        <StatePanel testId="claims-empty" icon={<UserCheck className="size-5" aria-hidden />} title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <Card className="divide-y divide-border overflow-hidden" data-testid="claims-list">
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("emptyTitle")}</p>
          ) : null}
          {visible.map((c) => (
            <div key={c.id} className="flex flex-col gap-3 px-4 py-4" data-testid="claim-row">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium" data-testid="claim-name">
                    {c.name}
                  </span>
                  <span className="truncate text-sm text-muted-foreground" dir="ltr" style={{ textAlign: "start" }}>
                    {c.email ?? t("noEmail")}
                  </span>
                </div>
                <div className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">{t("columns.role")}</span>
                  <Badge variant={ROLE_BADGE[c.roleKey] ?? "neutral"} data-testid="claim-role">
                    {tRoles(c.roleKey)}
                  </Badge>
                </div>
                <div className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">{t("columns.claimed")}</span>
                  <time dateTime={c.claimedAt} title={format.dateTime(new Date(c.claimedAt), { dateStyle: "medium", timeStyle: "short" })}>
                    {format.relativeTime(new Date(c.claimedAt))}
                  </time>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" onClick={() => decide(c, "approve")} data-testid="claim-approve">
                    <Check className="size-4" aria-hidden />
                    {t("approve")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setRejecting(rejecting === c.id ? null : c.id)}
                    aria-expanded={rejecting === c.id}
                    data-testid="claim-reject"
                  >
                    <X className="size-4" aria-hidden />
                    {t("reject")}
                  </Button>
                </div>
              </div>
              {errors[c.id] ? (
                <p role="alert" className="text-sm text-danger" data-testid="claim-error">
                  {t("toast.failed", { reason: t(`errors.${errors[c.id]}`) })}
                </p>
              ) : null}
              {rejecting === c.id ? (
                <form
                  className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    decide(c, "reject");
                  }}
                  data-testid="reject-form"
                >
                  <p className="text-sm font-medium">{t("rejectTitle", { name: c.name })}</p>
                  <Label htmlFor={`reason-${c.id}`} className="text-xs text-muted-foreground">
                    {t("reasonLabel", { name: c.name })}
                  </Label>
                  <Input
                    id={`reason-${c.id}`}
                    maxLength={280}
                    value={reasons[c.id] ?? ""}
                    placeholder={t("reasonPlaceholder")}
                    onChange={(e) => setReasons((r) => ({ ...r, [c.id]: e.target.value }))}
                    data-testid="reject-reason"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                      {t("cancel")}
                    </Button>
                    <Button type="submit" size="sm" variant="danger" data-testid="reject-confirm">
                      {t("confirmReject")}
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          ))}
        </Card>
      )}

      {held.length > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
          {held.slice(-3).map(({ key, item }) => (
            <div key={key} className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-border bg-foreground text-background shadow-lg" data-testid="claim-toast" data-outcome={item.decision}>
              <div className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="flex-1">
                  {item.decision === "approve" ? t("toast.approved", { name: item.name, role: tRoles(item.roleKey) }) : t("toast.rejected", { name: item.name })}
                </span>
                <button
                  type="button"
                  onClick={() => queue.undo(key)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-background underline-offset-2 transition-colors duration-150 hover:bg-background/15"
                  data-testid="claim-undo"
                >
                  <Undo2 className="size-4 rtl:-scale-x-100" aria-hidden />
                  {t("toast.undo")}
                </button>
                <button
                  type="button"
                  onClick={() => void queue.flush(key)}
                  aria-label={t("toast.saveNow")}
                  title={t("toast.saveNow")}
                  className="rounded p-1 opacity-70 hover:bg-background/15 hover:opacity-100"
                  data-testid="claim-save-now"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <div className="h-0.5 bg-background/20">
                <div className="ssos-countdown h-full bg-background/70" style={{ "--ssos-countdown": `${UNDO_MS}ms` } as CSSProperties} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
