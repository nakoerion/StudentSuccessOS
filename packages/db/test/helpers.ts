import { PrismaClient } from "@prisma/client";

import { seedId } from "../seed/deterministic";
import { COUNTS, TENANTS } from "../seed/fixtures";

export const TENANT_A = seedId("tenant", TENANTS[0]!.slug);
export const TENANT_B = seedId("tenant", TENANTS[1]!.slug);

export const EXPECTED = {
  persons: COUNTS.students + COUNTS.teachers + COUNTS.parents + COUNTS.advisors + COUNTS.admins,
  roleAssignments: COUNTS.students + COUNTS.teachers + COUNTS.parents + COUNTS.advisors + COUNTS.admins,
  guardianships: COUNTS.students,
} as const;

/** App-role client (DATABASE_URL = ssos_app). */
export function appClient(extraParams = ""): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — copy .env.example to .env");
  return new PrismaClient({ datasourceUrl: extraParams ? `${url}&${extraParams}` : url });
}

/** Owner client, for verifying that rejected writes really changed nothing. */
export function ownerClient(): PrismaClient {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  return new PrismaClient({ datasourceUrl: url });
}

/** Throw inside a transaction to roll it back after a successful positive check. */
export class Rollback extends Error {
  constructor() {
    super("rollback");
  }
}
