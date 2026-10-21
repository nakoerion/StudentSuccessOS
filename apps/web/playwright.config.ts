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
  // Supabase's transaction pooler adds ~1-3 s per query and a dashboard render is several
  // round-trips, so allow for latency (assertions stay the same; nothing is skipped).
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    locale: "en-US",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec dotenv -e ../../.env -- next start -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
