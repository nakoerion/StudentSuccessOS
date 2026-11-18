/**
 * `pnpm ai:sync-seats`: push every school's active student seat count to sso-ai once.
 * Idempotent. One line per tenant: slug, seats, resulting cap. Exit 1 if any tenant failed.
 */
import { createAdminClient } from "@ssos/db";

import { createSeatPusher, formatSeatSyncLine, seatPusherConfigFromEnv, syncSeatCounts } from "./seats";

async function main(): Promise<number> {
  const config = seatPusherConfigFromEnv();
  if (!config) {
    console.error("ai:sync-seats: SSO_AI_URL and SSO_AI_SERVICE_TOKEN must be set");
    return 1;
  }
  const db = createAdminClient();
  try {
    const r = await syncSeatCounts(db, createSeatPusher(config));
    for (const l of r.lines) console.info(formatSeatSyncLine(l));
    console.info(`ai:sync-seats: ${r.synced}/${r.tenants} tenants synced`);
    return r.failed === 0 ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error("ai:sync-seats failed", e);
    process.exit(1);
  },
);
