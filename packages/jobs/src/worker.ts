/**
 * Success-engine worker: `pnpm --filter @ssos/jobs worker`. Long-running; owner connection.
 */
import { createAdminClient } from "@ssos/db";

import { bossTransport, createBoss } from "./boss";
import { createHandlers } from "./handlers";
import { registerSuccessJobs } from "./register";

async function main(): Promise<void> {
  const boss = createBoss();
  boss.on("error", (e: unknown) => console.error("[jobs] pg-boss error", e));
  await boss.start();
  const db = createAdminClient();
  const handlers = createHandlers({ db, ...bossTransport(boss) });
  const reg = await registerSuccessJobs(boss, handlers);
  console.info(`[jobs] ready: ${reg.queues.length} queues, ${reg.subscriptions.length} topic subscriptions, ${reg.schedules.length} schedules`);

  const stop = async (signal: string) => {
    console.info(`[jobs] ${signal}: stopping`);
    await boss.stop({ graceful: true });
    await db.$disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((e: unknown) => {
  console.error("[jobs] failed to start", e);
  process.exit(1);
});
