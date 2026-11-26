/**
 * Join-claim approval: an admin approves or rejects a claim made with the join code.
 * Runs as the app role inside withTenant (RLS); restores the seed state with the owner client.
 */
import { createAdminClient, prisma, type TenantTx, userMemberships, withTenant } from "@ssos/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadViewer } from "../lib/access";
import { claimRoleWithJoinCode } from "../lib/join";
import { canApproveClaims, ClaimDecisionError, decideClaim, listPendingClaims, ownRejectedClaims } from "../lib/join-claims";
import { resolveLanding } from "../lib/tenancy";
import { createUndoQueue } from "../lib/undo-queue";

const owner = createAdminClient();
let joiner: { userId: string; name: string; email: string };
let tirane: { id: string; adminPersonId: string; adminUserId: string; teacherPersonId: string };
let abuDhabiId: string;

async function personFor(tenantId: string, email: string) {
  return owner.person.findFirstOrThrow({ where: { tenantId, userAccount: { email } }, select: { id: true, userAccountId: true } });
}

async function cleanup() {
  const people = await owner.person.findMany({ where: { userAccountId: joiner.userId }, select: { id: true } });
  await owner.event.deleteMany({ where: { subjectPersonId: { in: people.map((p) => p.id) } } });
  await owner.person.deleteMany({ where: { userAccountId: joiner.userId } });
}

async function claim(): Promise<string> {
  const res = await claimRoleWithJoinCode(joiner, "TIR-4821", "student");
  expect(res).toMatchObject({ ok: true, status: "pending" });
  const ra = await owner.roleAssignment.findFirstOrThrow({ where: { tenantId: tirane.id, person: { userAccountId: joiner.userId }, status: "pending" } });
  return ra.id;
}

const asAdmin = <T,>(fn: (tx: TenantTx) => Promise<T>, tenantId = tirane.id) => withTenant(tenantId, fn, { userId: tirane.adminUserId });
const decide = (claimId: string, decision: "approve" | "reject", reason?: string, tenantId = tirane.id) =>
  asAdmin(
    (tx) => decideClaim(tx, { tenantId, claimId, decision, deciderPersonId: tirane.adminPersonId, actorUserId: tirane.adminUserId, reason: reason ?? null }),
    tenantId,
  );
const eventsFor = (claimId: string) => owner.event.findMany({ where: { entityType: "role_assignment", entityId: claimId } });

beforeAll(async () => {
  const account = await owner.userAccount.findUniqueOrThrow({ where: { email: "join@demo.ssos.test" } });
  joiner = { userId: account.id, name: "New Claimant", email: account.email };
  const t = await owner.tenant.findUniqueOrThrow({ where: { slug: "liceu-demo-tirane" } });
  const a = await owner.tenant.findUniqueOrThrow({ where: { slug: "demo-school-abu-dhabi" } });
  abuDhabiId = a.id;
  const admin = await personFor(t.id, "admin.tirane@demo.ssos.test");
  const teacher = await personFor(t.id, "teacher.tirane@demo.ssos.test");
  tirane = { id: t.id, adminPersonId: admin.id, adminUserId: admin.userAccountId!, teacherPersonId: teacher.id };
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await owner.$disconnect();
  await prisma.$disconnect();
});

describe("join-claim approval", () => {
  it("lists the claim for the school's admin with name, e-mail, role and time", async () => {
    const id = await claim();
    const list = await asAdmin((tx) => listPendingClaims(tx));
    expect(list).toContainEqual(expect.objectContaining({ id, name: "New Claimant", email: "join@demo.ssos.test", roleKey: "student" }));
  });

  it("approve activates the membership and writes exactly one event", async () => {
    const id = await claim();
    expect(resolveLanding(await userMemberships(joiner.userId)).kind).toBe("pending");
    await expect(decide(id, "approve")).resolves.toEqual({ claimId: id, status: "active", changed: true });
    expect(resolveLanding(await userMemberships(joiner.userId))).toEqual({ kind: "tenant", slug: "liceu-demo-tirane" });
    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "join_claim.approved", actorPersonId: tirane.adminPersonId, tenantId: tirane.id });
  });

  it("approving twice is idempotent: still active, still one event", async () => {
    const id = await claim();
    await decide(id, "approve");
    await expect(decide(id, "approve")).resolves.toEqual({ claimId: id, status: "active", changed: false });
    expect(await eventsFor(id)).toHaveLength(1);
    // But a decided claim cannot be flipped the other way.
    await expect(decide(id, "reject")).rejects.toMatchObject({ code: "already_decided" });
  });

  it("reject leaves no membership, keeps the reason, and the person may claim again", async () => {
    const id = await claim();
    await decide(id, "reject", "  Not enrolled here.  ");
    const rows = await userMemberships(joiner.userId);
    expect(rows.some((r) => r.status === "active")).toBe(false);
    expect(resolveLanding(rows).kind).toBe("join");
    const person = await personFor(tirane.id, "join@demo.ssos.test");
    const own = await withTenant(tirane.id, (tx) => ownRejectedClaims(tx, person.id), { userId: joiner.userId });
    expect(own).toEqual([{ roleKey: "student", reason: "Not enrolled here." }]);
    expect((await eventsFor(id)).map((e) => e.type)).toEqual(["join_claim.rejected"]);
    // Claiming again starts a fresh wait.
    expect(await claim()).toBe(id);
    expect(resolveLanding(await userMemberships(joiner.userId)).kind).toBe("pending");
  });

  it("a person without permission to approve is refused (the route 404s on this check)", async () => {
    const teacher = await withTenant(tirane.id, (tx) => loadViewer(tx, tirane.teacherPersonId));
    const admin = await withTenant(tirane.id, (tx) => loadViewer(tx, tirane.adminPersonId));
    expect(canApproveClaims(teacher)).toBe(false);
    expect(canApproveClaims(admin)).toBe(true);
  });

  it("a claim from another school is invisible and cannot be decided there", async () => {
    const id = await claim();
    const other = await asAdmin((tx) => listPendingClaims(tx), abuDhabiId);
    expect(other.map((c) => c.id)).not.toContain(id);
    const emails = await withTenant(abuDhabiId, (tx) => tx.$queryRaw<{ email: string }[]>`SELECT * FROM ssos_pending_claimant_emails()`);
    expect(emails.map((e) => e.email)).not.toContain("join@demo.ssos.test");
    await expect(decide(id, "approve", undefined, abuDhabiId)).rejects.toBeInstanceOf(ClaimDecisionError);
    expect((await owner.roleAssignment.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(await eventsFor(id)).toHaveLength(0);
  });

  it("undo before the save leaves the claim pending and sends nothing", async () => {
    const id = await claim();
    vi.useFakeTimers();
    try {
      const commit = vi.fn(async () => {
        await decide(id, "approve");
      });
      const queue = createUndoQueue<string>({ delayMs: 8000, commit });
      const key = queue.schedule(id);
      vi.advanceTimersByTime(7000);
      expect(queue.undo(key)).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(commit).not.toHaveBeenCalled();
      expect(queue.pending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect((await owner.roleAssignment.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(await eventsFor(id)).toHaveLength(0);
  });

  it("without undo the decision is sent once the window passes", async () => {
    const sent: string[] = [];
    vi.useFakeTimers();
    try {
      const queue = createUndoQueue<string>({ delayMs: 8000, commit: async (x) => void sent.push(x) });
      const key = queue.schedule("c1");
      vi.advanceTimersByTime(8000);
      expect(sent).toEqual(["c1"]);
      expect(queue.undo(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
