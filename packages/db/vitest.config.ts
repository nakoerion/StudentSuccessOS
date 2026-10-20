import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Tests run against the real database in the repo-root .env (Supabase or local Postgres).
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One worker: tests share one database and assert exact seeded counts.
    fileParallelism: false,
  },
});
