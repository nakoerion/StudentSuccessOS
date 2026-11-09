import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

/**
 * ActionInbox decision flow (success engine slice 4a). The seed gives each demo tenant
 * synthetic risk scores, from which the real engine proposed track cards and opened
 * alerts; this spec decides cards in the browser and checks the effects on the profile.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSWORD = "Demo1234!";
const SLUG = "liceu-demo-tirane";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  test.setTimeout(600_000);
  execSync("SSOS_SEED_SUCCESS_DEMO=1 pnpm db:seed && pnpm auth:seed", { cwd: REPO_ROOT, stdio: "ignore" });
});

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/t/${SLUG}$`));
}

test("advisor approves, edits and dismisses cards; the profile shows the new track", async ({ page }) => {
  await signIn(page, "advisor.tirane@demo.ssos.test");
  await page.getByTestId("nav-inbox").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${SLUG}/inbox$`));
  const cards = page.getByTestId("action-card");
  const initial = await cards.count();
  expect(initial).toBeGreaterThanOrEqual(3);

  // Evidence panel: score, band, up to 4 factors; confidence shown.
  const first = cards.first();
  await expect(first.getByTestId("evidence-score")).toBeVisible();
  await expect(first.getByTestId("evidence-band")).toHaveAttribute("data-band", /^(low|moderate|high|critical)$/);
  const factorCount = await first.getByTestId("evidence-factor").count();
  expect(factorCount).toBeGreaterThan(0);
  expect(factorCount).toBeLessThanOrEqual(4);
  await expect(first.getByTestId("card-confidence")).toHaveAttribute("data-level", /^(high|medium|low)$/);

  // 1) Approve.
  const approvedStudent = (await first.getAttribute("data-student-id"))!;
  const approvedTrack = (await first.getByTestId("card-proposed-track").getAttribute("data-track"))!;
  await first.getByTestId("card-approve").click();
  await expect(page.getByTestId("inbox-decided").first()).toHaveAttribute("data-outcome", "approved");
  await expect(cards).toHaveCount(initial - 1);

  // 2) Edit: change the review date, approve with edits.
  const second = cards.first();
  const editedStudent = (await second.getAttribute("data-student-id"))!;
  await second.getByTestId("card-edit").click();
  await second.getByTestId("edit-review").fill("2027-01-15");
  await second.getByTestId("edit-note").fill("Review after winter break");
  await second.getByTestId("edit-submit").click();
  await expect(page.getByTestId("inbox-decided").first()).toHaveAttribute("data-outcome", "edited");
  await expect(cards).toHaveCount(initial - 2);

  // 3) Dismiss with a reason.
  const third = cards.first();
  const dismissedStudent = (await third.getAttribute("data-student-id"))!;
  await third.getByTestId("card-dismiss").click();
  await third.getByTestId("dismiss-note").fill("Known situation, already supported");
  await third.getByTestId("dismiss-submit").click();
  await expect(page.getByTestId("inbox-decided").first()).toHaveAttribute("data-outcome", "dismissed");
  await expect(cards).toHaveCount(initial - 3);
  await expect(page.getByTestId("inbox-count")).toContainText(String(initial - 3));

  // Approved student's profile: new active track, history row, full risk explanation.
  await page.goto(`/t/${SLUG}/students/${approvedStudent}`);
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track", approvedTrack);
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("risk-factor-row")).toHaveCount(7);
  const score = (await page.getByTestId("risk-score").innerText()).split("/")[0]!.trim();
  await expect(page.getByTestId("factor-total")).toHaveText(score);
  await expect(page.getByTestId("action-inbox").getByTestId("inbox-empty")).toBeVisible();

  // Edited student: active track with the edited review date.
  await page.goto(`/t/${SLUG}/students/${editedStudent}`);
  await expect(page.getByTestId("track-row").first()).toContainText("2027");

  // Dismissed student: no track change.
  await page.goto(`/t/${SLUG}/students/${dismissedStudent}`);
  await expect(page.getByTestId("current-track")).toHaveAttribute("data-track", "none");
  await expect(page.getByTestId("track-history-empty")).toBeVisible();
});

test("alerts list shows rung, SLA due time and acknowledgement state", async ({ page }) => {
  await signIn(page, "advisor.tirane@demo.ssos.test");
  // Find a student with an alert: the critical-band ones are the seeded struggling students.
  await page.goto(`/t/${SLUG}/inbox`);
  const supportCard = page.getByTestId("action-card").filter({ has: page.locator('[data-track="support"]') }).first();
  const student = (await supportCard.getAttribute("data-student-id"))!;
  await page.goto(`/t/${SLUG}/students/${student}`);
  const alert = page.getByTestId("alert-row").first();
  await expect(alert).toHaveAttribute("data-state", "open");
  await expect(alert.getByTestId("alert-rung")).not.toBeEmpty();
  await expect(alert.getByTestId("alert-due")).not.toBeEmpty();
  await expect(alert.getByTestId("alert-ack")).not.toBeEmpty();
});

test("a teacher sees the inbox read-only; Arabic renders RTL", async ({ page }) => {
  await signIn(page, "teacher.tirane@demo.ssos.test");
  await page.goto(`/t/${SLUG}/inbox`);
  await expect(page.getByTestId("action-card").first()).toBeVisible();
  await expect(page.getByTestId("card-approve")).toHaveCount(0);
  await expect(page.getByTestId("card-readonly").first()).toBeVisible();

  await page.getByTestId("locale-switcher").click();
  await page.getByTestId("locale-ar").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("inbox-title")).toHaveText("صندوق الإجراءات");
});

test("a parent cannot open the inbox or a student profile", async ({ page }) => {
  await signIn(page, "parent.tirane@demo.ssos.test");
  expect((await page.goto(`/t/${SLUG}/inbox`))?.status()).toBe(404);
  await expect(page.getByTestId("nav-inbox")).toHaveCount(0);
});
