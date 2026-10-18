import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __ssosPrisma?: PrismaClient };

/**
 * Runtime client. Connects with DATABASE_URL, which must be the RLS-enforced
 * `ssos_app` role. Reuses one instance across hot reloads in dev.
 */
export const prisma: PrismaClient = globalForPrisma.__ssosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__ssosPrisma = prisma;
}

/**
 * Owner/admin client (DATABASE_ADMIN_URL, BYPASSRLS). Only for migrations,
 * seed and trusted maintenance scripts. Never use it in request handlers.
 */
export function createAdminClient(): PrismaClient {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  return new PrismaClient({ datasourceUrl: url });
}
