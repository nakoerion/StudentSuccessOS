import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke test against a running production build:
 *   pnpm --filter @ssos/web build && pnpm db:seed
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/browsers pnpm --filter @ssos/web test:e2e
 * The webServer block starts `next start` on port 3100 if nothing is there yet.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec dotenv -e ../../.env -- next start -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
