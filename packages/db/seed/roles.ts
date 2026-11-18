/**
 * Applies newly defined system permissions and role grants to an existing
 * database without rebuilding the demo tenants (unlike `pnpm db:seed`).
 *
 *   pnpm db:seed:roles
 */
import { createAdminClient } from "../src/client";
import { PERMISSIONS } from "../src/system-roles";
import { seedSystemRoles } from "./system-roles";

const client = createAdminClient();
client
  .$transaction((tx) => seedSystemRoles(tx))
  .then(() => console.info(`System roles synced: ${PERMISSIONS.length} permissions.`))
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect());
