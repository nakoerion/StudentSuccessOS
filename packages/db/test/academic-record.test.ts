/**
 * Academic record (slice 1: schema) — RLS behaviour of the new tables in the live DB.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_CONCEPTS, DEMO_SUBJECTS } from "../seed/academic";
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

describe("academic record: tenant isolation", () => {
  for (const [label, tenantId, otherId] of [
    ["A (Tirana)", TENANT_A, TENANT_B],
    ["B (Abu Dhabi)", TENANT_B, TENANT_A],
  ] as const) {
    it(`tenant ${label} sees only its own academic_year / term / subject rows`, async () => {
      const r = await withTenant(
        tenantId,
        async (tx) => ({
          years: await tx.academicYear.findMany({ select: { tenantId: true } }),
          terms: await tx.term.findMany({ select: { tenantId: true } }),
          subjects: await tx.subject.findMany({ select: { tenantId: true } }),
          otherTerms: await tx.term.count({ where: { tenantId: otherId } }),
        }),
        { client: app },
      );
      expect(r.years).toHaveLength(1);
      expect(r.terms.length).toBeGreaterThanOrEqual(2);
      expect(r.subjects).toHaveLength(DEMO_SUBJECTS.length);
      for (const rows of [r.years, r.terms, r.subjects]) {
        expect(new Set(rows.map((x) => x.tenantId))).toEqual(new Set([tenantId]));
      }
      expect(r.otherTerms).toBe(0);
      // Owner sees the same per-tenant counts (RLS hides nothing of the tenant's own).
      expect(await owner.term.count({ where: { tenantId } })).toBe(r.terms.length);
    });
  }

  it("a known tenant-B academic_year id is invisible from tenant A, and cannot be updated", async () => {
    const bYear = await owner.academicYear.findFirstOrThrow({ where: { tenantId: TENANT_B } });
    const { seen, updated } = await withTenant(
      TENANT_A,
      async (tx) => ({
        seen: await tx.academicYear.findUnique({ where: { id: bYear.id } }),
        updated: (await tx.academicYear.updateMany({ where: { id: bYear.id }, data: { name: "Hacked" } })).count,
      }),
      { client: app },
    );
    expect(seen).toBeNull();
    expect(updated).toBe(0);
    expect((await owner.academicYear.findUniqueOrThrow({ where: { id: bYear.id } })).name).toBe(bYear.name);
  });

  it("rejects INSERT of a subject carrying another tenant's tenant_id", async () => {
    await expect(
      withTenant(TENANT_A, (tx) => tx.subject.create({ data: { tenantId: TENANT_B, code: "X", name: "X" } }), {
        client: app,
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects a term in tenant A that points at tenant B's academic year (composite FK)", async () => {
    const bYear = await owner.academicYear.findFirstOrThrow({ where: { tenantId: TENANT_B } });
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.term.create({
            data: {
              tenantId: TENANT_A,
              academicYearId: bYear.id,
              key: "x",
              name: "X",
              sequence: 99,
              startsOn: bYear.startsOn,
              endsOn: bYear.endsOn,
            },
          }),
        { client: app },
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it("positive control: a course -> section -> enrollment chain can be built in-tenant (rolled back)", async () => {
    const student = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A, externalRef: "S-001" } });
    await expect(
      withTenant(
        TENANT_A,
        async (tx) => {
          const year = await tx.academicYear.findFirstOrThrow();
          const subject = await tx.subject.findFirstOrThrow({ where: { code: "MATH" } });
          const course = await tx.course.create({
            data: { tenantId: TENANT_A, academicYearId: year.id, subjectId: subject.id, code: "MATH-10", name: "Math 10" },
          });
          const section = await tx.classSection.create({
            data: { tenantId: TENANT_A, courseId: course.id, code: "A", name: "Math 10 A" },
          });
          await tx.enrollment.create({
            data: { tenantId: TENANT_A, classSectionId: section.id, studentPersonId: student.id },
          });
          await tx.event.create({
            data: { tenantId: TENANT_A, type: "enrollment.created", subjectPersonId: student.id, payload: { course: "MATH-10" } },
          });
          expect(await tx.enrollment.count()).toBe(1);
          throw new Rollback();
        },
        { client: app },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await owner.course.count({ where: { tenantId: TENANT_A, code: "MATH-10" } })).toBe(0);
  });
});

describe("academic record: event is append-only for the app role", () => {
  it("INSERT + SELECT succeed; UPDATE and DELETE are denied", async () => {
    await expect(
      withTenant(
        TENANT_A,
        async (tx) => {
          const ev = await tx.event.create({
            data: { tenantId: TENANT_A, type: "rls.probe", payload: { ok: true }, evidenceRefs: [] },
          });
          expect(await tx.event.findUnique({ where: { id: ev.id } })).not.toBeNull();
          throw new Rollback();
        },
        { client: app },
      ),
    ).rejects.toBeInstanceOf(Rollback);

    await expect(
      withTenant(TENANT_A, (tx) => tx.$executeRaw`UPDATE "event" SET type = 'x'`, { client: app }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(TENANT_A, (tx) => tx.$executeRaw`DELETE FROM "event"`, { client: app }),
    ).rejects.toThrow(/permission denied/);
  });

  it("derived grades (term_grade, annual_grade) are read-only for the app role", async () => {
    expect(await withTenant(TENANT_A, (tx) => tx.termGrade.count(), { client: app })).toBe(0);
    for (const sql of [
      `UPDATE "term_grade" SET value = 0`,
      `DELETE FROM "annual_grade"`,
      `INSERT INTO "term_grade" (tenant_id, enrollment_id, term_id, grade_scale_id, value) VALUES ('${TENANT_A}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)`,
    ]) {
      await expect(withTenant(TENANT_A, (tx) => tx.$executeRawUnsafe(sql), { client: app })).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe("academic record: global curriculum tables", () => {
  it("concept / concept_edge are readable without a tenant and write-protected", async () => {
    const packs = await owner.countryPack.count();
    expect(await app.concept.count()).toBe(DEMO_CONCEPTS.length * packs);
    expect(await app.conceptEdge.count()).toBeGreaterThan(0);
    const concept = await app.concept.findFirstOrThrow();
    await expect(
      app.concept.create({ data: { countryPackId: concept.countryPackId, code: "rls.probe", name: "x" } }),
    ).rejects.toThrow(/permission denied/);
    await expect(app.$executeRaw`UPDATE concept SET name = 'x'`).rejects.toThrow(/permission denied/);
    await expect(app.$executeRaw`DELETE FROM concept_edge`).rejects.toThrow(/permission denied/);
  });

  it("mastery_state exists, is tenant-isolated and empty (populated in a later slice)", async () => {
    expect(await owner.masteryState.count()).toBe(0);
    expect(await withTenant(TENANT_A, (tx) => tx.masteryState.count(), { client: app })).toBe(0);
  });
});
