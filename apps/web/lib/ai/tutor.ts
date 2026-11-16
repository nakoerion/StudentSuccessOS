/**
 * Server-side context for the student tutor: which subjects (courses) the signed-in student
 * may open the tutor for, and the restriction scopes that apply to them. Everything runs
 * inside withTenant, so RLS bounds it to the tenant; the client only ever names a course id,
 * and subject/grade are resolved here from the student's own active enrollment.
 */
import type { TenantTx } from "@ssos/db";

export interface TutorSubject {
  /** Course id — what the browser sends back. */
  courseId: string;
  classSectionId: string;
  /** Subject name as the school entered it (sent to sso-ai as `subject`). */
  subject: string;
  courseName: string;
  grade: number;
}

/** "10", "Grade 10", "G10" → 10; anything without a 1..13 number → null. */
export function parseGrade(label: string | null | undefined): number | null {
  const m = label ? /(\d{1,2})/.exec(label) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 13 ? n : null;
}

export async function loadTutorSubjects(tx: TenantTx, studentPersonId: string): Promise<TutorSubject[]> {
  const rows = await tx.enrollment.findMany({
    where: { studentPersonId, status: "active" },
    select: {
      classSectionId: true,
      classSection: { select: { course: { select: { id: true, name: true, grade: true, subject: { select: { name: true } } } } } },
    },
  });
  const seen = new Set<string>();
  const out: TutorSubject[] = [];
  for (const r of rows) {
    const c = r.classSection.course;
    const grade = parseGrade(c.grade);
    if (grade === null || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ courseId: c.id, classSectionId: r.classSectionId, subject: c.subject.name, courseName: c.name, grade });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** Restriction scopes sso-ai checks teacher time-window/topic rules against ("tenant" is implicit). */
export function tutorScopes(s: Pick<TutorSubject, "classSectionId">, studentPersonId: string): string[] {
  return [`class:${s.classSectionId}`, `student:${studentPersonId}`];
}
