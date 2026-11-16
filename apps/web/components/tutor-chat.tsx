"use client";

import { Button, cn } from "@ssos/ui";
import { AlertTriangle, Bot, CloudOff, HeartHandshake, Loader2, RotateCcw, Send, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";

import { sendTutorTurn, type TutorTurnErrorCode } from "../app/t/[tenantSlug]/tutor/actions";

/** Mirrors sso-ai's TUTOR_MODES (kept local: lib/ai/client is server-only). */
const MODES = ["socratic", "concept", "worked_example", "practice", "exam_prep", "writing_feedback"] as const;
type Mode = (typeof MODES)[number];

type Entry =
  | { id: number; kind: "user"; text: string; mode: Mode }
  | { id: number; kind: "tutor"; text: string; mode: string }
  /** A refusal, budget or safety message: the service's own words, rendered verbatim. */
  | { id: number; kind: "notice"; outcome: "refused" | "handoff" | "unavailable"; reason: string; message: string }
  | { id: number; kind: "error"; code: TutorTurnErrorCode };
type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id"> : never) : never;

export function TutorUnavailable() {
  const t = useTranslations("tutor.unavailable");
  return (
    <div role="status" data-testid="tutor-unavailable" className="flex items-start gap-3 rounded-lg border border-border bg-surface p-6">
      <CloudOff className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t("title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
      </div>
    </div>
  );
}

export function TutorChat({ tenantSlug, subjects }: { tenantSlug: string; subjects: { courseId: string; label: string }[] }) {
  const t = useTranslations("tutor");
  const [courseId, setCourseId] = useState(subjects[0]?.courseId ?? "");
  const [mode, setMode] = useState<Mode>("socratic");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [down, setDown] = useState(false);
  const [pending, startTransition] = useTransition();
  const nextId = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const subjectId = useId();
  const inputId = useId();

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length, pending]);

  const push = (e: NewEntry) => setEntries((prev) => [...prev, { ...e, id: nextId.current++ } as Entry]);

  function reset() {
    setSessionId(null);
    setEntries([]);
    setDown(false);
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || pending || !courseId) return;
    push({ kind: "user", text, mode });
    setDraft("");
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof sendTutorTurn>>;
      try {
        res = await sendTutorTurn({ tenantSlug, courseId, mode, text, sessionId });
      } catch {
        res = { ok: false, code: "unavailable" };
      }
      if (!res.ok) {
        if (res.code === "session_expired") setSessionId(null);
        if (res.code === "unavailable") {
          setDown(true);
          setDraft(text);
        }
        push({ kind: "error", code: res.code });
        return;
      }
      setDown(false);
      const r = res.result;
      setSessionId(r.sessionId);
      if (r.outcome === "answered") push({ kind: "tutor", text: r.text, mode: r.mode });
      else push({ kind: "notice", outcome: r.outcome, reason: r.outcome === "handoff" ? r.category : r.reason, message: r.message });
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e as unknown as FormEvent);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="tutor-chat">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={subjectId} className="text-sm font-medium">
            {t("subject")}
          </label>
          <select
            id={subjectId}
            data-testid="tutor-subject"
            value={courseId}
            onChange={(e) => {
              setCourseId(e.target.value);
              reset();
            }}
            className="h-9 min-w-56 rounded-md border border-border bg-surface px-3 text-sm"
          >
            {subjects.map((s) => (
              <option key={s.courseId} value={s.courseId}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={reset} disabled={pending} data-testid="tutor-new" className="ms-auto">
          <RotateCcw className="size-4" aria-hidden />
          {t("newConversation")}
        </Button>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("mode")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("mode")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-testid={`tutor-mode-${m}`}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-lg border border-border bg-surface p-3 text-start transition-colors hover:bg-muted",
                mode === m && "border-brand ring-2 ring-brand/30",
              )}
            >
              <span className="block text-sm font-medium">{t(`modes.${m}.label`)}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t(`modes.${m}.hint`)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {down ? <TutorUnavailable /> : null}

      <div
        className="flex min-h-64 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        data-testid="tutor-conversation"
        aria-live="polite"
      >
        {entries.length === 0 ? <p className="m-auto text-sm text-muted-foreground">{t("empty")}</p> : null}
        {entries.map((e) => (
          <EntryView key={e.id} entry={e} />
        ))}
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="tutor-thinking">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("thinking")}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="flex items-end gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t("inputLabel")}
        </label>
        <textarea
          id={inputId}
          data-testid="tutor-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={8000}
          rows={2}
          dir="auto"
          placeholder={t("placeholder")}
          className="min-h-11 flex-1 resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={pending || !draft.trim()} data-testid="tutor-send">
          <Send className="size-4 rtl:-scale-x-100" aria-hidden />
          {t("send")}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t("disclaimer")}</p>
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  const t = useTranslations("tutor");
  switch (entry.kind) {
    case "user":
      return (
        <div className="max-w-[85%] self-end rounded-lg bg-brand px-3 py-2 text-sm text-brand-foreground" data-testid="tutor-msg-user">
          <p className="whitespace-pre-wrap" dir="auto">
            {entry.text}
          </p>
          <p className="mt-1 text-[11px] opacity-80">{t(`modes.${entry.mode}.label`)}</p>
        </div>
      );
    case "tutor":
      return (
        <div className="flex max-w-[85%] gap-2 self-start" data-testid="tutor-msg-tutor">
          <Bot className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm" dir="auto">
            {entry.text}
          </p>
        </div>
      );
    case "notice": {
      const Icon = entry.outcome === "handoff" ? HeartHandshake : entry.outcome === "refused" ? ShieldAlert : AlertTriangle;
      return (
        <div
          role="status"
          data-testid="tutor-notice"
          data-outcome={entry.outcome}
          data-reason={entry.reason}
          className={cn(
            "flex max-w-[85%] gap-2 self-start rounded-lg border px-3 py-2 text-sm",
            entry.outcome === "handoff" ? "border-brand/40 bg-brand/5" : "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {/* The service's message, exactly as returned — never reworded or translated here. */}
          <p className="whitespace-pre-wrap" dir="auto" data-testid="tutor-notice-message">
            {entry.message}
          </p>
        </div>
      );
    }
    case "error":
      return (
        <p role="alert" data-testid="tutor-error" data-code={entry.code} className="self-start text-sm text-danger">
          {t(`errors.${entry.code}`)}
        </p>
      );
  }
}
