/**
 * pg-boss itself: owner-only connection, and one live round trip through the real queue
 * (publish -> topic subscription -> worker), with the job id deduplicating a re-publish.
 * Uses its own pg-boss schema, dropped afterwards; the handlers are stubs, so no tenant
 * data is touched.
 */
import { createAdminClient, type PrismaClient } from "@ssos/db";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertOwnerUrl, bossTransport, roleOfUrl } from "../src/boss";
import { studentQueueFor } from "../src/events";
import type { SuccessHandlers } from "../src/handlers";
import { registerSuccessJobs } from "../src/register";

const TEST_SCHEMA = "pgboss_sso_test";

describe("jobs: pg-boss runs on the owner connection only", () => {
  it("refuses the app role (plain and Supabase-pooler user names); strips Prisma-only params", () => {
    expect(() => assertOwnerUrl("postgresql://ssos_app:pw@localhost:5432/ssos?schema=public")).toThrow(/must not connect as ssos_app/);
    expect(() => assertOwnerUrl("postgresql://ssos_app.abcref:pw@pooler.example:6543/postgres?pgbouncer=true")).toThrow(/ssos_app/);
    expect(() => assertOwnerUrl(undefined)).toThrow(/DATABASE_ADMIN_URL/);
    expect(roleOfUrl("postgresql://ssos_owner.abcref:pw@h:5432/postgres")).toBe("ssos_owner");
    const ok = assertOwnerUrl("postgresql://ssos_owner:pw@localhost:5432/ssos?schema=public&sslmode=disable");
    expect(ok).not.toContain("schema=");
    expect(ok).toContain("sslmode=disable");
  });

  it("the env's DATABASE_ADMIN_URL is an owner role and DATABASE_URL is not usable for the queue", () => {
    expect(() => assertOwnerUrl(process.env.DATABASE_ADMIN_URL)).not.toThrow();
    expect(() => assertOwnerUrl(process.env.DATABASE_URL)).toThrow(/ssos_app/);
  });
});

describe("jobs: live pg-boss round trip", () => {
  let boss: PgBoss;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = createAdminClient();
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    boss = new PgBoss({ connectionString: assertOwnerUrl(process.env.DATABASE_ADMIN_URL), schema: TEST_SCHEMA, schedule: false, supervise: false });
    boss.on("error", () => undefined);
    await boss.start();
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 }).catch(() => undefined);
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await owner.$disconnect();
  });

  it("a published student.graded reaches its subscriber exactly once, even when re-published with the same id", async () => {
    const seen: { topic: string; data: unknown }[] = [];
    const handlers: SuccessHandlers = {
      onStudentEvent: async (topic, data) => {
        seen.push({ topic, data });
        return { status: "skipped", reason: "stub", topic };
      },
      recomputeTenant: async () => ({ status: "skipped" }),
      nightly: async () => ({ tenants: 0 }),
      relayDomainEvents: async () => ({ scanned: 0, published: 0, skipped: 0, cursor: null }),
    };
    const reg = await registerSuccessJobs(boss, handlers);
    expect(reg.subscriptions.map((s) => s.queue)).toContain(studentQueueFor("student.graded"));

    const t = bossTransport(boss);
    const id = "6f1c2a52-7d0b-4c1e-9a43-0c8e2b9a1d10";
    const data = { tenantId: "11111111-1111-4111-8111-111111111111", studentPersonId: "22222222-2222-4222-8222-222222222222", eventId: id };
    await t.publish("student.graded", data, { id });
    await t.publish("student.graded", data, { id }); // relay re-run after a crash

    const deadline = Date.now() + 30_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 3_000)); // give a duplicate the chance to show up
    expect(seen).toEqual([{ topic: "student.graded", data }]);

    // pg-boss's own tables live in its own schema, owned by the owner role — never ssos_app.
    const [row] = await owner.$queryRaw<{ owner: string }[]>`SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = ${TEST_SCHEMA}`;
    expect(row?.owner).not.toBe("ssos_app");
  });
});
