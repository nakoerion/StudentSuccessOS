import { readFileSync } from "node:fs";

import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { policyFor, renderRlsSql, rlsMigrationPath } from "../rls/generate";
import { ACCESS_PRIVILEGES, GLOBAL_TABLES, TENANT_SCOPED_TABLES } from "../rls/tables";
import { appClient } from "./helpers";

const tenantModels = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "tenantId"));

const ACADEMIC_TENANT_TABLES = [
  "academic_year",
  "term",
  "subject",
  "course",
  "class_section",
  "enrollment",
  "teacher_assignment",
  "timetable_slot",
  "attendance_event",
  "assessment_category",
  "grade_entry",
  "term_grade",
  "annual_grade",
  "assignment",
  "submission",
  "rubric_score",
  "note",
  "event",
  "edge",
  "mastery_state",
];

describe("RLS generator coverage (Prisma DMMF)", () => {
  it("every model with a tenantId field is in the RLS table list, and vice versa", () => {
    const fromSchema = tenantModels.map((m) => m.name).sort();
    const fromList = TENANT_SCOPED_TABLES.map((t) => t.model).sort();
    expect(fromList).toEqual(fromSchema);
  });

  it("each entry's table name and scope match the schema (nullable tenant_id <=> shared)", () => {
    for (const model of tenantModels) {
      const entry = TENANT_SCOPED_TABLES.find((t) => t.model === model.name)!;
      const field = model.fields.find((f) => f.name === "tenantId")!;
      expect({ model: model.name, table: model.dbName ?? model.name }).toEqual({ model: model.name, table: entry.table });
      expect({ model: model.name, shared: !field.isRequired }).toEqual({
        model: model.name,
        shared: entry.scope === "shared",
      });
    }
  });

  it("the generator emits ENABLE + FORCE RLS and a tenant policy for every tenant-scoped model", () => {
    const sql = renderRlsSql();
    for (const model of tenantModels) {
      const table = model.dbName ?? model.name;
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON "${table}"`);
    }
    // All policies come from the one template.
    for (const t of TENANT_SCOPED_TABLES) expect(sql).toContain(policyFor(t));
  });

  it("the academic-record tables are classified: tenant-scoped vs global, with access modes", () => {
    const tenant = new Map(TENANT_SCOPED_TABLES.map((t) => [t.table, t]));
    for (const table of ACADEMIC_TENANT_TABLES) expect(tenant.get(table)?.scope, table).toBe("tenant");
    expect(tenant.get("event")?.access).toBe("append_only");
    expect(tenant.get("term_grade")?.access).toBe("derived");
    expect(tenant.get("annual_grade")?.access).toBe("derived");
    const global = new Map(GLOBAL_TABLES.map((t) => [t.table, t]));
    for (const table of ["concept", "concept_edge"]) {
      expect(global.get(table), table).toEqual({ table, privileges: "SELECT" });
    }
  });

  it("the committed RLS migration is exactly the generator's output (no drift)", () => {
    expect(readFileSync(rlsMigrationPath(), "utf8")).toBe(renderRlsSql());
  });
});

describe("RLS in the live database", () => {
  let app: PrismaClient;
  beforeAll(() => {
    app = appClient();
  });
  afterAll(async () => {
    await app.$disconnect();
  });

  it("every table with a tenant_id column has RLS enabled + forced and a tenant_isolation policy", async () => {
    const rows = await app.$queryRaw<
      { table: string; rls: boolean; forced: boolean; policies: string[] | null }[]
    >`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT array_agg(p.policyname::text ORDER BY p.policyname) FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM information_schema.columns col
      JOIN pg_class c ON c.relname = col.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = col.table_schema
      WHERE col.table_schema = 'public' AND col.column_name = 'tenant_id' AND c.relkind = 'r'
      ORDER BY c.relname`;

    expect(rows.map((r) => r.table).sort()).toEqual(TENANT_SCOPED_TABLES.map((t) => t.table).sort());
    for (const r of rows) {
      expect({ table: r.table, rls: r.rls, forced: r.forced }).toEqual({ table: r.table, rls: true, forced: true });
      expect(r.policies ?? []).toContain("tenant_isolation");
    }
  });

  it("the app role's table privileges match each tenant table's access mode", async () => {
    const rows = await app.$queryRaw<{ table: string; privs: string[] }[]>`
      SELECT c.relname::text AS table,
             ARRAY(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
                    WHERE has_table_privilege('ssos_app', c.oid, p)) AS privs
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${TENANT_SCOPED_TABLES.map((t) => t.table)})`;
    const actual = Object.fromEntries(rows.map((r) => [r.table, r.privs.join(", ")]));
    const expected = Object.fromEntries(
      TENANT_SCOPED_TABLES.map((t) => [t.table, ACCESS_PRIVILEGES[t.access ?? "read_write"]]),
    );
    expect(actual).toEqual(expected);
  });

  it("with no tenant set, every academic-record tenant table reads empty", async () => {
    for (const table of ACADEMIC_TENANT_TABLES) {
      const [row] = await app.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`);
      expect({ table, n: Number(row!.n) }).toEqual({ table, n: 0 });
    }
  });

  it("global tables have explicit forced RLS, and the readable ones return rows to the app role", async () => {
    const rows = await app.$queryRaw<{ table: string; rls: boolean; forced: boolean }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${GLOBAL_TABLES.map((t) => t.table)})`;
    expect(rows.map((r) => r.table).sort()).toEqual(GLOBAL_TABLES.map((t) => t.table).sort());
    for (const r of rows) expect(r).toEqual({ table: r.table, rls: true, forced: true });

    // Without a tenant selected: lookup tables are fully readable (regression: on Supabase
    // auto-enabled RLS with no policy made `permission` read as empty).
    expect(await app.permission.count()).toBeGreaterThan(0);
    expect(await app.countryPack.count()).toBeGreaterThan(0);
    // System roles -> grants -> permissions resolve as the app role (the loadViewer shape).
    const roles = await app.role.findMany({
      where: { tenantId: null },
      select: { key: true, rolePermissions: { select: { permission: { select: { key: true } } } } },
    });
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.flatMap((r) => r.rolePermissions).length).toBeGreaterThan(0);
    // ...but still read-only, and tenant/user_account stay closed.
    await expect(app.permission.create({ data: { key: "rls.probe", description: "x" } })).rejects.toThrow();
    expect(await app.tenant.count()).toBe(0);
    await expect(app.userAccount.count()).rejects.toThrow();
  });
});
