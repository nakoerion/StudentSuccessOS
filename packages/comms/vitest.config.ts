import { defineConfig } from "vitest/config";

// Pure unit tests: no database, no network, no provider credentials.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
