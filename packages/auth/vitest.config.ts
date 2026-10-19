import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
