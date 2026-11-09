/**
 * Postgres implementation of the @ssos/comms OutboxStore port, scoped to the tenant of
 * the transaction it is given (use inside `withTenant`, so RLS confines every read and
 * write). Claims are compare-and-set on (state, attempts); the outbox_state_guard
 * trigger independently refuses any illegal lifecycle move.
 */
import type { Channel, OutboxPatch, OutboxRecipient, OutboxRow, OutboxStore } from "@ssos/comms";
import type { ChannelBinding, Outbox, Prisma } from "@prisma/client";

import type { TenantTx } from "./with-tenant";

type Row = Outbox & { channelBinding: ChannelBinding | null };

function asVariables(json: Prisma.JsonValue): Record<string, unknown> {
  return json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function recipientOf(binding: ChannelBinding | null): OutboxRecipient | null {
  return binding ? { externalId: binding.externalId, optInState: binding.optInState, meta: asVariables(binding.meta) } : null;
}

export function prismaOutboxStore(tx: TenantTx): OutboxStore {
  /** Rows addressed to a person rather than a binding use that person's binding on the channel. */
  async function toRow(r: Row): Promise<OutboxRow> {
    let binding = r.channelBinding;
    if (!binding && r.recipientPersonId) {
      const bindings = await tx.channelBinding.findMany({
        where: { personId: r.recipientPersonId, channel: r.channel },
        orderBy: { createdAt: "asc" },
      });
      binding = bindings.find((b) => b.optInState === "opted_in") ?? bindings[0] ?? null;
    }
    return {
      id: r.id,
      channel: r.channel,
      template: r.template,
      locale: r.locale,
      payload: asVariables(r.payload),
      state: r.state,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      nextAttemptAt: r.nextAttemptAt,
      idempotencyKey: r.idempotencyKey,
      recipient: recipientOf(binding),
    };
  }

  return {
    async due(now, limit) {
      const rows = await tx.outbox.findMany({
        where: { state: { in: ["queued", "failed"] }, nextAttemptAt: { lte: now } },
        include: { channelBinding: true },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      return Promise.all(rows.map(toRow));
    },

    async transition(id, expected, patch: OutboxPatch) {
      const { count } = await tx.outbox.updateMany({
        where: { id, state: expected.state, attempts: expected.attempts },
        data: {
          state: patch.state,
          ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
          ...(patch.nextAttemptAt ? { nextAttemptAt: patch.nextAttemptAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.providerMessageId ? { providerMessageId: patch.providerMessageId } : {}),
          ...(patch.sentAt ? { sentAt: patch.sentAt } : {}),
          ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
        },
      });
      return count === 1;
    },

    async findByProviderMessageId(channel: Channel, providerMessageId: string) {
      const row = await tx.outbox.findFirst({ where: { channel, providerMessageId }, include: { channelBinding: true } });
      return row ? toRow(row) : null;
    },

    async optOut(channel: Channel, externalId: string, at: Date) {
      const { count } = await tx.channelBinding.updateMany({
        where: { channel, externalId, optInState: { not: "opted_out" } },
        data: { optInState: "opted_out", optedOutAt: at },
      });
      return count;
    },
  };
}
