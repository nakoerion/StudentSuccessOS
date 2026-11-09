import { CHANNELS, FakeDriver, OUTBOX_STATES, deliveryTime, isQuietAt, outcomeOfSend } from "@ssos/comms";
import { CommChannel, OutboxState, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_NOTIFICATION_PREFERENCES } from "../src/comms-defaults";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, TENANT_A, TENANT_B } from "./helpers";

let app: PrismaClient;
let owner: PrismaClient;

/** Comms fixtures per tenant, created as the owner and removed afterwards. */
const fixtures = new Map<string, { personId: string; outboxIds: string[] }>();

const COMMS_TABLES = [
  "thread",
  "message",
  "channelBinding",
  "outbox",
  "announcement",
  "notification",
  "notificationPreference",
  "digestRun",
] as const;

async function seedComms(tenantId: string, tag: string): Promise<{ personId: string; outboxIds: string[] }> {
  const person = await owner.person.findFirstOrThrow({ where: { tenantId }, orderBy: { id: "asc" } });
  const section = await owner.classSection.findFirstOrThrow({ where: { tenantId }, orderBy: { id: "asc" } });
  const thread = await owner.thread.create({
    data: { tenantId, scope: "student", studentPersonId: person.id, subject: `test ${tag}` },
  });
  await owner.thread.create({ data: { tenantId, scope: "class_section", classSectionId: section.id } });
  const binding = await owner.channelBinding.create({
    data: { tenantId, personId: person.id, channel: "whatsapp", externalId: `+000${tag}`, optInState: "opted_in", optedInAt: new Date() },
  });
  await owner.message.create({
    data: { tenantId, threadId: thread.id, direction: "inbound", body: "hello", channel: "whatsapp", channelBindingId: binding.id, externalMessageId: `wamid.${tag}` },
  });
  const announcement = await owner.announcement.create({
    data: { tenantId, audience: "school", title: "Test", body: "Body", locale: "en", publishedAt: new Date() },
  });
  await owner.notification.create({
    data: { tenantId, recipientPersonId: person.id, category: "announcement", announcementId: announcement.id },
  });
  const run = await owner.digestRun.create({
    data: { tenantId, periodStart: new Date("2026-01-05"), periodEnd: new Date("2026-01-11") },
  });
  const outbox = await owner.outbox.create({
    data: { tenantId, channel: "whatsapp", recipientPersonId: person.id, channelBindingId: binding.id, template: "digest.weekly", locale: "en", digestRunId: run.id },
  });
  return { personId: person.id, outboxIds: [outbox.id] };
}

async function cleanup(tenantId: string): Promise<void> {
  await owner.outbox.deleteMany({ where: { tenantId } });
  await owner.notification.deleteMany({ where: { tenantId } });
  await owner.message.deleteMany({ where: { tenantId } });
  await owner.thread.deleteMany({ where: { tenantId } });
  await owner.channelBinding.deleteMany({ where: { tenantId } });
  await owner.announcement.deleteMany({ where: { tenantId } });
  await owner.digestRun.deleteMany({ where: { tenantId } });
}

beforeAll(async () => {
  app = appClient();
  owner = ownerClient();
  for (const t of [TENANT_A, TENANT_B]) await cleanup(t);
  fixtures.set(TENANT_A, await seedComms(TENANT_A, "a"));
  fixtures.set(TENANT_B, await seedComms(TENANT_B, "b"));
});
afterAll(async () => {
  for (const t of [TENANT_A, TENANT_B]) await cleanup(t);
  await app.$disconnect();
  await owner.$disconnect();
});

describe("comms enums match @ssos/comms", () => {
  it("channels and outbox states are the same lists in Postgres and in the adapter package", () => {
    expect(Object.values(CommChannel)).toEqual([...CHANNELS]);
    expect(Object.values(OutboxState)).toEqual([...OUTBOX_STATES]);
  });
});

describe("comms tenant isolation", () => {
  for (const [label, tenantId, otherId] of [
    ["A (Tirana)", TENANT_A, TENANT_B],
    ["B (Abu Dhabi)", TENANT_B, TENANT_A],
  ] as const) {
    it(`tenant ${label} sees only its own rows in all eight comms tables`, async () => {
      const seen = await withTenant(
        tenantId,
        async (tx) => {
          const out: Record<string, string[]> = {};
          for (const t of COMMS_TABLES) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- uniform probe over 8 delegates
            const rows = (await (tx[t] as any).findMany({ select: { tenantId: true } })) as { tenantId: string }[];
            out[t] = rows.map((r) => r.tenantId);
          }
          return out;
        },
        { client: app },
      );
      for (const t of COMMS_TABLES) {
        expect(seen[t]!.length, t).toBeGreaterThan(0);
        expect(new Set(seen[t]), t).toEqual(new Set([tenantId]));
      }
    });

    it(`tenant ${label} cannot write into the other tenant`, async () => {
      const other = fixtures.get(otherId)!;
      await expect(
        withTenant(
          tenantId,
          (tx) => tx.outbox.create({ data: { tenantId: otherId, channel: "email", recipientPersonId: other.personId, template: "x", locale: "en" } }),
          { client: app },
        ),
      ).rejects.toThrow();
      const touched = await withTenant(
        tenantId,
        (tx) => tx.outbox.updateMany({ where: { id: { in: other.outboxIds } }, data: { lastError: "hijacked" } }),
        { client: app },
      );
      expect(touched.count).toBe(0);
    });
  }

  it("without a tenant the app role reads nothing", async () => {
    for (const t of COMMS_TABLES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- uniform probe over 8 delegates
      expect(await (app[t] as any).count(), t).toBe(0);
    }
  });
});

describe("comms constraints", () => {
  it("rejects a thread with no target and a preference that is both role and person", async () => {
    const { personId } = fixtures.get(TENANT_A)!;
    await expect(withTenant(TENANT_A, (tx) => tx.thread.create({ data: { tenantId: TENANT_A, scope: "student" } }), { client: app })).rejects.toThrow(
      /thread_scope_target/,
    );
    await expect(
      withTenant(
        TENANT_A,
        (tx) => tx.notificationPreference.create({ data: { tenantId: TENANT_A, roleKey: "parent", personId, category: "alert", channels: ["push"] } }),
        { client: app },
      ),
    ).rejects.toThrow(/notification_preference_owner/);
  });
});

describe("outbox state transitions", () => {
  const set = (id: string, data: Parameters<PrismaClient["outbox"]["update"]>[0]["data"]) =>
    withTenant(TENANT_A, (tx) => tx.outbox.update({ where: { id }, data }), { client: app });

  async function fresh(maxAttempts = 3): Promise<string> {
    const { personId } = fixtures.get(TENANT_A)!;
    const row = await withTenant(
      TENANT_A,
      (tx) => tx.outbox.create({ data: { tenantId: TENANT_A, channel: "sms", recipientPersonId: personId, template: "alert.critical", locale: "sq", maxAttempts } }),
      { client: app },
    );
    expect(row).toMatchObject({ state: "queued", attempts: 0 });
    return row.id;
  }

  it("walks queued -> sending -> failed -> sending -> sent -> delivered, counting attempts", async () => {
    const id = await fresh();
    await set(id, { state: "sending", attempts: 1 });
    await set(id, { state: "failed", lastError: "timeout" });
    await set(id, { state: "sending", attempts: 2 });
    await set(id, { state: "sent", sentAt: new Date(), providerMessageId: "p1" });
    const done = await set(id, { state: "delivered", deliveredAt: new Date() });
    expect(done).toMatchObject({ state: "delivered", attempts: 2 });
    await expect(set(id, { state: "failed" })).rejects.toThrow(/outbox_lifecycle/);
    await expect(set(id, { lastError: "late edit" })).rejects.toThrow(/outbox_lifecycle/);
  });

  it("refuses illegal moves, a non-queued insert, uncounted attempts and stamp-less sent", async () => {
    const id = await fresh();
    await expect(set(id, { state: "delivered", deliveredAt: new Date(), sentAt: new Date() })).rejects.toThrow(/outbox_lifecycle/);
    await expect(set(id, { state: "sending" })).rejects.toThrow(/outbox_lifecycle/); // attempts not counted
    await expect(set(id, { state: "sending", attempts: 2 })).rejects.toThrow(/outbox_lifecycle/);
    await set(id, { state: "sending", attempts: 1 });
    await expect(set(id, { state: "sent" })).rejects.toThrow(/outbox_state_stamped/);
    await expect(
      withTenant(
        TENANT_A,
        (tx) => tx.outbox.create({ data: { tenantId: TENANT_A, channel: "sms", recipientPersonId: fixtures.get(TENANT_A)!.personId, template: "t", locale: "en", state: "sent", sentAt: new Date() } }),
        { client: app },
      ),
    ).rejects.toThrow(/outbox_lifecycle/);
    await set((await fresh()), { state: "cancelled" });
  });

  it("drives a row to dead through the fake driver once retries are exhausted", async () => {
    const id = await fresh(2);
    const driver = new FakeDriver("sms").failNext(5);
    const now = new Date("2026-11-09T10:00:00Z");
    let row = await withTenant(TENANT_A, (tx) => tx.outbox.findUniqueOrThrow({ where: { id } }), { client: app });
    while (row.state === "queued" || row.state === "failed") {
      row = await set(id, { state: "sending", attempts: row.attempts + 1 });
      const result = await driver.send({ idempotencyKey: id, channel: "sms", to: "+000", template: row.template, locale: row.locale, variables: {} });
      const outcome = outcomeOfSend(result, row.attempts, row.maxAttempts, now);
      row = await set(id, { state: outcome.state, lastError: outcome.state === "sent" ? null : outcome.lastError });
    }
    expect(row).toMatchObject({ state: "dead", attempts: 2, lastError: "fake_unavailable: simulated provider failure" });
    expect(driver.sent).toHaveLength(2);
  });
});

describe("quiet hours in the tenant's time zone (seeded defaults)", () => {
  it("each demo school has the full set of role defaults", async () => {
    for (const t of [TENANT_A, TENANT_B]) {
      const n = await withTenant(t, (tx) => tx.notificationPreference.count({ where: { personId: null } }), { client: app });
      expect(n).toBe(DEFAULT_NOTIFICATION_PREFERENCES.length);
    }
  });

  it("the parents' 21:00–07:00 window is evaluated in each school's own zone", async () => {
    const at = new Date("2026-11-09T19:30:00Z"); // 20:30 in Tirana, 23:30 in Abu Dhabi
    const result: Record<string, { quiet: boolean; deliverAt: string; critical: string }> = {};
    for (const t of [TENANT_A, TENANT_B]) {
      const { tz, pref } = await withTenant(
        t,
        async (tx) => ({
          tz: (await tx.tenant.findUniqueOrThrow({ where: { id: t } })).timezone,
          pref: await tx.notificationPreference.findFirstOrThrow({ where: { roleKey: "parent", category: "digest", personId: null } }),
        }),
        { client: app },
      );
      const quiet = { startMinute: pref.quietStartMinute!, endMinute: pref.quietEndMinute! };
      result[tz] = {
        quiet: isQuietAt(at, quiet, tz),
        deliverAt: deliveryTime({ now: at, timeZone: tz, quiet }).at.toISOString(),
        critical: deliveryTime({ now: at, timeZone: tz, quiet, critical: true, criticalBypassesQuiet: pref.criticalBypassesQuiet }).at.toISOString(),
      };
    }
    expect(result).toEqual({
      "Europe/Tirane": { quiet: false, deliverAt: at.toISOString(), critical: at.toISOString() },
      "Asia/Dubai": { quiet: true, deliverAt: "2026-11-10T03:00:00.000Z", critical: at.toISOString() },
    });
  });
});
