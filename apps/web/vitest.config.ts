import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Integration tests use the real local Postgres (repo-root .env), as ssos_app.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
