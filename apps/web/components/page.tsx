/**
 * Shared page furniture for /t/<school>/… routes: one header style, and one shape for
 * empty, unavailable and loading states so every screen reads the same way.
 */
import { cn } from "@ssos/ui";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, testId, actions }: { title: string; subtitle?: string; testId?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid={testId}>
          {title}
        </h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** An empty / unavailable state: what happened, and what to do next. */
export function StatePanel({ testId, title, body, icon, tone = "neutral", action }: { testId?: string; title: string; body: string; icon?: ReactNode; tone?: "neutral" | "watch"; action?: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border px-6 py-10 text-center",
        tone === "watch" ? "border-warn/40 bg-warn-subtle text-warn-foreground" : "border-border bg-surface",
      )}
      data-testid={testId}
    >
      {icon ? <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</span> : null}
      <p className="font-medium">{title}</p>
      <p className={cn("max-w-md text-sm", tone === "watch" ? "" : "text-muted-foreground")}>{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("ssos-skeleton", className)} aria-hidden />;
}
