import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultClient } from "./client";

export type TenantTx = Prisma.TransactionClient;

export interface WithTenantOptions {
  /** Auth identity of the caller; exposed to SQL as app.user_id. */
  userId?: string | null;
  /** Override the client (tests, scripts). Defaults to the ssos_app client. */
  client?: PrismaClient;
  timeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * Run `fn` inside one transaction scoped to a tenant. Sets the
 * transaction-local settings app.tenant_id and app.user_id
 * (equivalent to SET LOCAL), which the RLS policies read. The settings vanish
 * at COMMIT/ROLLBACK, so pooled connections never leak a tenant.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  if (options.userId) assertUuid(options.userId, "userId");
  const client = options.client ?? defaultClient;

  return client.$transaction(
    async (tx) => {
      // set_config(..., true) == SET LOCAL, but parameterised (no SQL injection).
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${options.userId ?? ""}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 10_000 },
  );
}
