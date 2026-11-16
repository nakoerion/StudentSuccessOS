"use server";

import { getLocale } from "next-intl/server";

import { isLocale } from "../../../../i18n/config";
import { canUseTutor } from "../../../../lib/access";
import { AiServiceError, createAiClient, isTutorMode, type TutorTurnResult } from "../../../../lib/ai/client";
import { loadTutorSubjects, tutorScopes } from "../../../../lib/ai/tutor";
import { requireTenant } from "../../../../lib/session";

export type TutorTurnErrorCode = "unavailable" | "session_expired" | "pii_blocked" | "rate_limited" | "invalid";

export type TutorTurnResponse = { ok: true; result: TutorTurnResult } | { ok: false; code: TutorTurnErrorCode };

export interface TutorTurnInput {
  tenantSlug: string;
  courseId: string;
  mode: string;
  text: string;
  sessionId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT = 8000;

/**
 * One tutor turn for the signed-in student. The student, tenant, subject, grade, country and
 * restriction scopes are all resolved on the server; the browser names only a course it is
 * enrolled in, a mode, its text and the session it is continuing. The tutor answers in the
 * UI locale. The service's result is passed through untouched (messages are never reworded).
 */
export async function sendTutorTurn(input: TutorTurnInput): Promise<TutorTurnResponse> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > MAX_INPUT || !isTutorMode(input.mode) || !UUID.test(input.courseId ?? "")) {
    return { ok: false, code: "invalid" };
  }
  if (input.sessionId && !UUID.test(input.sessionId)) return { ok: false, code: "invalid" };

  const { membership, viewer, db } = await requireTenant(input.tenantSlug);
  if (!canUseTutor(viewer)) return { ok: false, code: "invalid" };
  const subject = (await db((tx) => loadTutorSubjects(tx, membership.personId))).find((s) => s.courseId === input.courseId);
  if (!subject) return { ok: false, code: "invalid" };

  const locale = await getLocale();
  const client = createAiClient(membership.tenantId);
  try {
    const result = await client.tutorTurn({
      studentId: membership.personId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      language: isLocale(locale) ? locale : "en",
      mode: input.mode,
      input: text,
      subject: subject.subject,
      grade: subject.grade,
      country: membership.countryCode,
      scopes: tutorScopes(subject, membership.personId),
    });
    return { ok: true, result };
  } catch (err) {
    if (!(err instanceof AiServiceError)) throw err;
    switch (err.kind) {
      case "session_not_found":
        return { ok: false, code: "session_expired" };
      case "pii_blocked":
        return { ok: false, code: "pii_blocked" };
      case "rate_limited":
        return { ok: false, code: "rate_limited" };
      case "invalid_request":
        return { ok: false, code: "invalid" };
      default:
        if (err.kind !== "not_configured") console.error("[tutor] sso-ai call failed:", err.message);
        return { ok: false, code: "unavailable" };
    }
  }
}
