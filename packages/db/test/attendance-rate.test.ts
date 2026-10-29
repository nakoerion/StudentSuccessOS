/**
 * Attendance rate (slice 3b): the `attendance_rate_mv` materialised view, its owner-only
 * refresh, and the tenant-filtered, read-only `attendance_rate` view the app reads.
 *
 * Golden cases run as the owner inside a rolled-back transaction: REFRESH MATERIALIZED
 * VIEW is transactional, so the refreshed contents vanish with the rollback. The RLS
 * case commits a handful of rows, refreshes, reads through the app role, then deletes
 * the rows and refreshes again.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TENANT_DERIVED_VIEWS } from "../rls/tables";
import {
  attendanceRate,
  listAttendanceRates,
  recordAttendance,
  refreshAttendanceRate,
  type AttendanceRateRow,
} from "../src/attendance";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, Rollback, TENANT_A, TENANT_B } from "./helpers";

let app: PrismaClient;
let owner: PrismaClient;

beforeAll(() => {
  app = appClient();
  owner = ownerClient();
});
afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

async function ownerRolledBack<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await owner
    .$transaction(
      async (tx) => {
        out = await fn(tx);
        throw new Rollback();
      },
      { timeout: 180_000, maxWait: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

type Status = "present" | "late" | "absent" | "excused";

/** Active enrollments of the seeded section of `courseCode`. */
async function enrollments(db: Prisma.TransactionClient | PrismaClient, tenantId: string, courseCode: string) {
  return db.enrollment.findMany({
    where: { tenantId, status: "active", classSection: { course: { code: courseCode } } },
    select: { id: true, studentPersonId: true },
    orderBy: { studentPersonId: "asc" },
  });
}

/** MV rows straight from the materialised view (owner). */
async function mvRows(db: Prisma.TransactionClient | PrismaClient, tenantId: string): Promise<AttendanceRateRow[]> {
  const rows = await db.$queryRaw<
    { student_person_id: string; term_id: string | null; present: number; late: number; absent: number; excused: number; total: number; present_rate: string | null }[]
  >`SELECT student_person_id::text, term_id::text, present, late, absent, excused, total, present_rate::text AS present_rate
    FROM attendance_rate_mv WHERE tenant_id = ${tenantId}::uuid ORDER BY student_person_id, term_id NULLS LAST`;
  return rows.map((r) => ({
    tenantId,
    studentPersonId: r.student_person_id,
    termId: r.term_id,
    present: r.present,
    late: r.late,
    absent: r.absent,
    excused: r.excused,
    total: r.total,
    presentRate: r.present_rate === null ? null : Number(r.present_rate),
  }));
}

/** Consecutive weekdays from `start` (YYYY-MM-DD), one per status. */
function days(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("attendance_rate: golden cases (owner, rolled back)", () => {
  it(
    "counts per status and present_rate = ROUND(100*(present+late)/total, 2): late attends, excused stays in the denominator",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const [t1, t2] = await tx.term.findMany({ where: { tenantId: TENANT_A }, orderBy: { sequence: "asc" } });
        const [a, b, c] = await enrollments(tx, TENANT_A, "MATH-10");
        const mark = async (e: { id: string; studentPersonId: string }, statuses: Status[], start: string) => {
          const ds = days(start, statuses.length);
          for (let i = 0; i < statuses.length; i++)
            await recordAttendance(tx, { tenantId: TENANT_A, enrollmentId: e.id, studentPersonId: e.studentPersonId, date: ds[i]!, status: statuses[i]! });
        };
        // Student A, term 1: 6 present, 2 late, 1 absent, 1 excused -> 8/10 = 80.00
        await mark(a!, ["present", "present", "late", "present", "absent", "present", "excused", "late", "present", "present"], "2026-10-05");
        // Student A, term 2: 1 present, 1 late, 1 excused -> 2/3 = 66.67 (late attends, excused denominates)
        await mark(a!, ["present", "late", "excused"], "2027-02-01");
        // Student B, term 1: only late -> 100.00; only excused for C -> 0.00
        await mark(b!, ["late", "late"], "2026-10-05");
        await mark(c!, ["excused"], "2026-10-05");
        // Term boundary days are attributed by [starts_on, ends_on] inclusive.
        await recordAttendance(tx, { tenantId: TENANT_A, enrollmentId: b!.id, studentPersonId: b!.studentPersonId, date: "2027-01-30", status: "absent" }); // last day of term 1
        await recordAttendance(tx, { tenantId: TENANT_A, enrollmentId: b!.id, studentPersonId: b!.studentPersonId, date: "2027-01-31", status: "present" }); // first day of term 2

        // Before refresh the MV is stale (derived, not live).
        const stale = await mvRows(tx, TENANT_A);
        await refreshAttendanceRate(tx);
        return { t1: t1!.id, t2: t2!.id, a: a!.studentPersonId, b: b!.studentPersonId, c: c!.studentPersonId, stale, rows: await mvRows(tx, TENANT_A) };
      });
      expect(r.stale).toEqual([]);
      const row = (student: string, term: string) => r.rows.find((x) => x.studentPersonId === student && x.termId === term);
      expect(row(r.a, r.t1)).toMatchObject({ present: 6, late: 2, absent: 1, excused: 1, total: 10, presentRate: 80 });
      expect(row(r.a, r.t2)).toMatchObject({ present: 1, late: 1, absent: 0, excused: 1, total: 3, presentRate: 66.67 });
      expect(row(r.b, r.t1)).toMatchObject({ present: 0, late: 2, absent: 1, excused: 0, total: 3, presentRate: 66.67 });
      expect(row(r.b, r.t2)).toMatchObject({ present: 1, late: 0, absent: 0, excused: 0, total: 1, presentRate: 100 });
      expect(row(r.c, r.t1)).toMatchObject({ present: 0, late: 0, absent: 0, excused: 1, total: 1, presentRate: 0 });
      expect(r.rows).toHaveLength(5);
      // The SQL formula and the pure helper agree on every row.
      for (const x of r.rows) expect(x.presentRate).toBe(attendanceRate(x));
      // Rolled back: the committed MV has no tenant-A rows.
      await refreshAttendanceRate(owner);
      expect(await mvRows(owner, TENANT_A)).toEqual([]);
    },
    180_000,
  );

  it(
    "events dated in no term (the gap between UAE terms) are kept with term_id NULL (unassigned)",
    async () => {
      const r = await ownerRolledBack(async (tx) => {
        const [e] = await enrollments(tx, TENANT_B, "MATH-10");
        const termOf = async (date: string) =>
          tx.term.findFirst({ where: { tenantId: TENANT_B, startsOn: { lte: new Date(date) }, endsOn: { gte: new Date(date) } }, select: { id: true } });
        expect(await termOf("2026-12-21")).toBeNull(); // inside the academic year, between term-1 and term-2
        const t1 = (await termOf("2026-12-10"))!.id;
        const rec = (date: string, status: Status) =>
          recordAttendance(tx, { tenantId: TENANT_B, enrollmentId: e!.id, studentPersonId: e!.studentPersonId, date, status });
        await rec("2026-12-10", "present");
        await rec("2026-12-21", "absent");
        await rec("2026-12-22", "late");
        await refreshAttendanceRate(tx);
        return { t1, rows: await mvRows(tx, TENANT_B) };
      });
      expect(r.rows.map((x) => [x.termId, x.present, x.late, x.absent, x.total, x.presentRate])).toEqual([
        [r.t1, 1, 0, 0, 1, 100],
        [null, 0, 1, 1, 2, 50],
      ]);
    },
    120_000,
  );
});

describe("attendance_rate: app role (tenant view, read-only)", () => {
  it(
    "ssos_app sees only its own tenant's rows, cannot write the view, read the MV or refresh",
    async () => {
      const [a] = await enrollments(owner, TENANT_A, "MATH-10");
      const [b] = await enrollments(owner, TENANT_B, "MATH-10");
      const created: string[] = [];
      try {
        created.push((await recordAttendance(owner, { tenantId: TENANT_A, enrollmentId: a!.id, studentPersonId: a!.studentPersonId, date: "2026-10-05", status: "present" })).id);
        created.push((await recordAttendance(owner, { tenantId: TENANT_A, enrollmentId: a!.id, studentPersonId: a!.studentPersonId, date: "2026-10-06", status: "absent" })).id);
        created.push((await recordAttendance(owner, { tenantId: TENANT_B, enrollmentId: b!.id, studentPersonId: b!.studentPersonId, date: "2026-10-05", status: "late" })).id);
        await refreshAttendanceRate(owner);

        const asA = await withTenant(TENANT_A, (tx) => listAttendanceRates(tx), { client: app });
        expect(asA.map((x) => [x.tenantId, x.studentPersonId, x.total, x.presentRate])).toEqual([[TENANT_A, a!.studentPersonId, 2, 50]]);
        const asB = await withTenant(TENANT_B, (tx) => listAttendanceRates(tx, { studentPersonId: b!.studentPersonId }), { client: app });
        expect(asB.map((x) => [x.tenantId, x.total, x.presentRate])).toEqual([[TENANT_B, 1, 100]]);
        // B asking for A's student by id gets nothing.
        expect(await withTenant(TENANT_B, (tx) => listAttendanceRates(tx, { studentPersonId: a!.studentPersonId }), { client: app })).toEqual([]);
        // No tenant selected -> no rows.
        const [none] = await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM attendance_rate`;
        expect(none!.n).toBe(0);

        // Read-only: no writes on the view, no access to the MV, no refresh.
        for (const sql of [
          `INSERT INTO attendance_rate (tenant_id, student_person_id, present, late, absent, excused, total) VALUES ('${TENANT_A}', '${a!.studentPersonId}', 1, 0, 0, 0, 1)`,
          `UPDATE attendance_rate SET present_rate = 100`,
          `DELETE FROM attendance_rate`,
          `SELECT count(*) FROM attendance_rate_mv`,
          `SELECT refresh_attendance_rate()`,
          `REFRESH MATERIALIZED VIEW attendance_rate_mv`,
        ]) {
          await expect(withTenant(TENANT_A, (tx) => tx.$executeRawUnsafe(sql), { client: app }), sql).rejects.toThrow();
        }
      } finally {
        await owner.event.deleteMany({ where: { entityId: { in: created } } });
        await owner.attendanceEvent.deleteMany({ where: { id: { in: created } } });
        await refreshAttendanceRate(owner);
      }
      expect(await mvRows(owner, TENANT_A)).toEqual([]);
    },
    180_000,
  );

  it("privileges in the catalog: view SELECT only, MV and refresh closed to ssos_app", async () => {
    const [p] = await app.$queryRaw<{ view: string[]; mv: string[]; refresh: boolean; kind: string }[]>`
      SELECT ARRAY(SELECT x FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) x WHERE has_table_privilege('ssos_app', 'attendance_rate', x)) AS view,
             ARRAY(SELECT x FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) x WHERE has_table_privilege('ssos_app', 'attendance_rate_mv', x)) AS mv,
             has_function_privilege('ssos_app', 'refresh_attendance_rate()', 'EXECUTE') AS refresh,
             (SELECT relkind::text FROM pg_class WHERE relname = 'attendance_rate_mv') AS kind`;
    expect(p).toEqual({ view: ["SELECT"], mv: [], refresh: false, kind: "m" });
    expect(TENANT_DERIVED_VIEWS).toContainEqual({ view: "attendance_rate", source: "attendance_rate_mv" });
  });
});
