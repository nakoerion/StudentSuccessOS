/**
 * Seat-count sync (seat-count-sync-spec.md): seat counting over the seeded database (inside
 * rolled-back owner transactions), the push contract to sso-ai, and the nightly job's
 * "never fail because of sso-ai" rule.
 */
import { countActiveSeats, createAdminClient, listTenantSeats, type Prisma, type PrismaClient } from "@ssos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHandlers, type JobDeps } from "../src/handlers";
import { createSeatPusher, formatSeatSyncLine, type PushSeats, type SeatsResponse, syncSeatCounts } from "../src/seats";

type Tx = Prisma.TransactionClient;
const TENANT_A_SLUG = "liceu-demo-tirane";

let owner: PrismaClient;
let tenantA: string;
beforeAll(async () => {
  owner = createAdminClient();
  tenantA = (await owner.tenant.findFirstOrThrow({ where: { slug: TENANT_A_SLUG } })).id;
});
afterAll(async () => {
  await owner.$disconnect();
});

class Rollback extends Error {}
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await owner
    .$transaction(async (tx) => {
      out = await fn(tx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out as T;
}

const okResponse = (tenantId: string, seats: number): SeatsResponse => {
  const cap = Math.max(50, (seats * 10) / 100);
  return {
    tenantId,
    seats,
    caps: { discretionary: cap, essential: Math.max(10, cap * 0.2) },
    derivation: { discretionary: { basis: cap > 50 ? "per_seat" : "floor", capUsd: cap }, essential: { basis: "floor", capUsd: 10 } },
  };
};

describe("seat counting", () => {
  it("counts each student with an active enrolment once, per tenant", async () => {
    const rows = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT student_person_id) AS n FROM enrollment WHERE tenant_id = ${tenantA}::uuid AND status = 'active'`;
    const seats = await countActiveSeats(owner, tenantA);
    expect(seats).toBe(Number(rows[0]!.n));
    expect(seats).toBeGreaterThan(0);
    const enrolments = await owner.enrollment.count({ where: { tenantId: tenantA, status: "active" } });
    expect(enrolments).toBeGreaterThan(seats); // students sit in several classes, counted once
    const all = await listTenantSeats(owner);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.find((t) => t.tenantId === tenantA)).toEqual({ tenantId: tenantA, slug: TENANT_A_SLUG, seats });
  });

  it("a student whose enrolments are all withdrawn no longer counts; one still active in another class does", async () => {
    const r = await rolledBack(async (tx) => {
      const before = await countActiveSeats(tx, tenantA);
      const multi = await tx.enrollment.groupBy({ by: ["studentPersonId"], where: { tenantId: tenantA, status: "active" }, _count: true, orderBy: { studentPersonId: "asc" } });
      const [a, b] = multi.filter((m) => m._count > 1);
      await tx.enrollment.updateMany({ where: { tenantId: tenantA, studentPersonId: a!.studentPersonId }, data: { status: "withdrawn" } });
      const one = await tx.enrollment.findFirstOrThrow({ where: { tenantId: tenantA, studentPersonId: b!.studentPersonId } });
      await tx.enrollment.update({ where: { id: one.id }, data: { status: "completed" } });
      return { before, after: await countActiveSeats(tx, tenantA) };
    });
    expect(r.after).toBe(r.before - 1);
  });
});

describe("syncSeatCounts", () => {
  it("pushes only the tenant id and an integer for every tenant; one failure does not stop the rest", async () => {
    const calls: unknown[][] = [];
    const push: PushSeats = async (...args) => {
      calls.push(args);
      if (args[0] === tenantA) throw new Error("sso-ai unreachable");
      return okResponse(args[0], args[1]);
    };
    const r = await syncSeatCounts(owner, push);
    const tenants = await owner.tenant.count();
    expect(r.tenants).toBe(tenants);
    expect(calls).toHaveLength(tenants);
    for (const c of calls) {
      expect(c).toHaveLength(2);
      expect(typeof c[0]).toBe("string");
      expect(Number.isInteger(c[1])).toBe(true);
    }
    expect(r.failed).toBe(1);
    expect(r.synced).toBe(tenants - 1);
    const failed = r.lines.find((l) => l.tenantId === tenantA)!;
    expect(formatSeatSyncLine(failed)).toContain("NOT SYNCED");
    const ok = r.lines.find((l) => l.status === "synced")!;
    expect(formatSeatSyncLine(ok)).toMatch(/seats=\d+\tcap=\$\d+\.\d{2} \((floor|per_seat)\)/);
  });
});

describe("createSeatPusher", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  it("PUTs { seats } with the service token and returns the service's caps", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const push = createSeatPusher({
      baseUrl: "http://ai.test",
      token: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(okResponse(T, 130)), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await push(T, 130);
    expect(r.caps.discretionary).toBe(50);
    expect(seen[0]!.url).toBe(`http://ai.test/v1/tenants/${T}/seats`);
    expect(seen[0]!.init.method).toBe("PUT");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ seats: 130 });
  });

  it("throws on a network failure, a non-2xx answer, another tenant's answer, or a bad count", async () => {
    const mk = (f: () => Promise<Response>) => createSeatPusher({ baseUrl: "http://ai.test", token: "tok", fetch: f as unknown as typeof fetch });
    await expect(mk(() => Promise.reject(new Error("ECONNREFUSED")))(T, 1)).rejects.toThrow("unreachable");
    await expect(mk(async () => new Response("{}", { status: 503 }))(T, 1)).rejects.toThrow("503");
    await expect(mk(async () => new Response(JSON.stringify(okResponse("other", 1))))(T, 1)).rejects.toThrow("unexpected");
    await expect(mk(async () => new Response("{}"))(T, -1)).rejects.toThrow("invalid seat count");
  });
});

describe("nightly seat sync", () => {
  const base = (extra: Partial<JobDeps>): JobDeps => ({ db: owner, publish: async () => undefined, send: async () => undefined, ...extra });

  it("runs after the fan-out and reports per tenant", async () => {
    const logs: string[] = [];
    const res = await createHandlers(base({ pushSeats: async (t, s) => okResponse(t, s), log: (l) => logs.push(l) })).nightly();
    expect(res.tenants).toBeGreaterThanOrEqual(2);
    expect(res.seats).toEqual({ synced: await owner.tenant.count(), failed: 0 });
    expect(logs.some((l) => l.includes(TENANT_A_SLUG))).toBe(true);
  });

  it("an unreachable sso-ai is logged and never fails the nightly recompute", async () => {
    const logs: string[] = [];
    const sent: string[] = [];
    const res = await createHandlers(
      base({
        send: async (q) => {
          sent.push(q);
        },
        pushSeats: async () => {
          throw new Error("sso-ai unreachable");
        },
        log: (l) => logs.push(l),
      }),
    ).nightly();
    expect(sent.length).toBe(res.tenants);
    expect(res.seats).toMatchObject({ synced: 0 });
    expect(logs.every((l) => l.includes("NOT SYNCED"))).toBe(true);
  });

  it("without a pusher (sso-ai not configured) the nightly job is unchanged", async () => {
    const res = await createHandlers(base({})).nightly();
    expect(res.seats).toBeUndefined();
  });
});
