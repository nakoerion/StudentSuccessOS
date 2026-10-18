import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSWORD = "Demo1234!";

// Reset the demo tenants (the join flow writes to them) before the run.
test.beforeAll(() => {
  execSync("pnpm db:seed", { cwd: REPO_ROOT, stdio: "ignore" });
});

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
}

test("admin.tirane signs in, sees the Albanian dashboard and opens people", async ({ page }) => {
  await signIn(page, "admin.tirane@demo.ssos.test");
  await expect(page).toHaveURL(/\/t\/liceu-demo-tirane$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "sq");
  await expect(page.getByTestId("school-name")).toHaveText("Liceu Demo Tiranë");
  await expect(page.getByTestId("dashboard-title")).toContainText("Mirë se vini");
  await expect(page.getByTestId("count-students")).toHaveText("30");
  await expect(page.getByTestId("count-teachers")).toHaveText("6");
  await expect(page.getByTestId("count-parents")).toHaveText("20");
  await expect(page.getByTestId("count-classes")).toHaveText("3");

  await page.getByTestId("open-people").click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByTestId("person-row")).toHaveCount(56);
  await page.getByTestId("tab-teacher").click();
  await expect(page.getByTestId("person-row")).toHaveCount(6);
});

test("a parent sees only their own children", async ({ page }) => {
  await signIn(page, "parent.tirane@demo.ssos.test");
  await expect(page).toHaveURL(/\/t\/liceu-demo-tirane$/);
  await expect(page.getByTestId("summary-cards")).toHaveCount(0);
  await page.goto("/t/liceu-demo-tirane/people?role=teacher");
  await expect(page.getByTestId("person-row")).toHaveCount(2);
});

test("join@ uses the join code and waits for approval", async ({ page }) => {
  await signIn(page, "join@demo.ssos.test");
  await expect(page).toHaveURL(/\/join$/);
  await page.locator("#code").fill("tir-4821");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/join\?code=TIR-4821/);
  await page.getByTestId("role-parent").check();
  await page.locator('form button[type="submit"]').last().click();
  await expect(page.getByTestId("pending-approval")).toBeVisible();
  await expect(page.getByTestId("pending-approval")).toContainText("Liceu Demo Tiranë");
});

test("switching to Arabic sets dir=rtl and persists", async ({ page }) => {
  await signIn(page, "admin.abudhabi@demo.ssos.test");
  await expect(page).toHaveURL(/\/t\/demo-school-abu-dhabi$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByTestId("locale-switcher").click();
  await page.getByTestId("locale-ar").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByTestId("dashboard-title")).toContainText("مرحبًا");

  await page.goto("/t/demo-school-abu-dhabi/people");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("no session -> sign-in; other tenant's slug -> 404", async ({ page }) => {
  await page.goto("/t/liceu-demo-tirane");
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, "admin.abudhabi@demo.ssos.test");
  await expect(page).toHaveURL(/\/t\/demo-school-abu-dhabi$/);
  const res = await page.goto("/t/liceu-demo-tirane/people");
  expect(res?.status()).toBe(404);
});
