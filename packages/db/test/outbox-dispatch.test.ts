import { fakeProviders, OutboxDispatcher } from "@ssos/comms";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prismaOutboxStore } from "../src/outbox-store";
import { withTenant } from "../src/with-tenant";
import { appClient, ownerClient, TENANT_A, TENANT_B } from "./helpers";

let app: PrismaClient;
let owner: PrismaClient;
const NOW = new Date("2026-11-09T10:00:00Z");
const PHONE = "+355690009991";

async function cleanup(): Promise<void> {
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await owner.outbox.deleteMany({ where: { tenantId, template: { startsWith: "alert." }, idempotencyKey: { startsWith: "dispatch-test" } } });
    await owner.channelBinding.deleteMany({ where: { tenantId, externalId: { startsWith: "+35569000999" } } });
  }
}

beforeAll(async () => {
  app = appClient();
  owner = ownerClient();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.$disconnect();
  await owner.$disconnect();
});

describe("outbox dispatcher on Postgres", () => {
  it("records sent, failed, delivered and opted-out states inside the tenant only", async () => {
    const person = await owner.person.findFirstOrThrow({ where: { tenantId: TENANT_A }, orderBy: { id: "asc" } });
    const binding = await owner.channelBinding.create({
      data: { tenantId: TENANT_A, personId: person.id, channel: "whatsapp", externalId: PHONE, optInState: "opted_in", optedInAt: NOW },
    });
    const mk = (key: string, extra: object) =>
      owner.outbox.create({
        data: { tenantId: TENANT_A, channel: "whatsapp", template: "alert.critical", locale: "sq", payload: { student: "A", reason: "r" }, idempotencyKey: `dispatch-test-${key}`, nextAttemptAt: NOW, ...extra },
      });
    const byBinding = await mk("1", { channelBindingId: binding.id });
    const byPerson = await mk("2", { recipientPersonId: person.id });

    const fakes = fakeProviders({ webhookSecret: "t" });
    fakes.whatsapp.failWhen((m) => (m.idempotencyKey.endsWith("2") ? { code: "rate_limited" } : null));

    // Tenant B's worker cannot see or touch tenant A's rows.
    const other = await withTenant(TENANT_B, (tx) => new OutboxDispatcher(prismaOutboxStore(tx), fakes, { now: () => NOW }).dispatchDue(), { client: app });
    expect(other.sent + other.failed).toBe(0);

    const dispatcher = (tx: Parameters<typeof prismaOutboxStore>[0]) => new OutboxDispatcher(prismaOutboxStore(tx), fakes, { now: () => NOW });
    const summary = await withTenant(TENANT_A, (tx) => dispatcher(tx).dispatchDue(), { client: app });
    expect(summary).toMatchObject({ sent: 1, failed: 1 });

    const sent = await owner.outbox.findUniqueOrThrow({ where: { id: byBinding.id } });
    expect(sent).toMatchObject({ state: "sent", attempts: 1, providerMessageId: "fake-whatsapp-1" });
    expect(await owner.outbox.findUniqueOrThrow({ where: { id: byPerson.id } })).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: "rate_limited: simulated provider failure",
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });

    const hook = await withTenant(
      TENANT_A,
      (tx) =>
        dispatcher(tx).handleWebhook(
          "whatsapp",
          fakes.whatsapp.webhook([
            { kind: "receipt", receipt: { channel: "whatsapp", providerMessageId: "fake-whatsapp-1", status: "delivered", at: NOW } },
            { kind: "inbound", message: { channel: "whatsapp", from: PHONE, externalMessageId: "in-1", text: "Ndalo", receivedAt: NOW } },
          ]),
        ),
      { client: app },
    );
    expect(hook).toMatchObject({ accepted: true, receiptsApplied: 1, inbound: [] });
    expect(await owner.outbox.findUniqueOrThrow({ where: { id: byBinding.id } })).toMatchObject({ state: "delivered", deliveredAt: NOW });
    expect(await owner.channelBinding.findUniqueOrThrow({ where: { id: binding.id } })).toMatchObject({ optInState: "opted_out", optedOutAt: NOW });

    // The retry is due later, but the parent has opted out: it is cancelled, not sent.
    const later = new Date(NOW.getTime() + 60_000);
    const retry = await withTenant(TENANT_A, (tx) => new OutboxDispatcher(prismaOutboxStore(tx), fakes, { now: () => later }).dispatchDue(), { client: app });
    expect(retry).toMatchObject({ sent: 0, cancelled: 1 });
    expect(await owner.outbox.findUniqueOrThrow({ where: { id: byPerson.id } })).toMatchObject({ state: "cancelled", lastError: "recipient_opted_out" });
  });
});
