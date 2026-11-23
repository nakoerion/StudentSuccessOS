import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

/**
 * Phone-width check (390 × 844): every shell page fits the viewport with no sideways
 * scroll, the sidebar gives way to the drawer, and the same holds in Arabic (RTL).
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSWORD = "Demo1234!";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  test.setTimeout(600_000);
  execSync("SSOS_SEED_SUCCESS_DEMO=1 pnpm db:seed && pnpm auth:seed", { cwd: REPO_ROOT, stdio: "ignore" });
});

async function signIn(page: Page, email: string, slug: string) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}$`));
}

/** No horizontal overflow: the document is no wider than the viewport. */
async function expectFitsWidth(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const { scroll, viewport } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(scroll, `${label}: page is ${scroll}px wide in a ${viewport}px viewport`).toBeLessThanOrEqual(viewport);
}

test("advisor: shell pages fit a phone, navigation goes through the drawer", async ({ page }) => {
  const slug = "liceu-demo-tirane";
  await signIn(page, "advisor.tirane@demo.ssos.test", slug);
  await expect(page.getByTestId("app-sidebar")).toBeHidden();
  await expectFitsWidth(page, "dashboard");

  await page.getByTestId("drawer-open").click();
  await expect(page.getByTestId("app-drawer")).toBeVisible();
  await page.getByTestId("app-drawer").getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/inbox$`));
  await expect(page.getByTestId("action-card").first()).toBeVisible();
  await expectFitsWidth(page, "inbox");

  for (const path of ["people", "mastery"]) {
    await page.goto(`/t/${slug}/${path}`);
    await expectFitsWidth(page, path);
  }
  await page.goto(`/t/${slug}/people?q=zzzz-no-such-person`);
  await expect(page.getByTestId("people-no-match")).toBeVisible();
  await expectFitsWidth(page, "people (no match)");
});

test("admin in Arabic: dashboard, people and AI usage fit a phone in RTL", async ({ page }) => {
  const slug = "demo-school-abu-dhabi";
  await signIn(page, "admin.abudhabi@demo.ssos.test", slug);
  await page.getByTestId("locale-switcher").first().click();
  await page.getByTestId("locale-ar").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  try {
    await expectFitsWidth(page, "ar dashboard");
    for (const path of ["people", "ai-usage"]) {
      await page.goto(`/t/${slug}/${path}`);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expectFitsWidth(page, `ar ${path}`);
    }
  } finally {
    // Leave the demo admin in English for the other specs.
    await page.getByTestId("locale-switcher").first().click();
    await page.getByTestId("locale-en").click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  }
});
