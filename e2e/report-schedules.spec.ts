import { expect, test, type Page } from "@playwright/test";

/**
 * Report schedule management (spec 012, US1 — T009).
 *
 * The E2E environment shares one dev database across runs, so specs never
 * assume an empty schedule list: they count rows before/after and always
 * operate on the LAST row (the one the test just created). Raw share tokens
 * never appear anywhere in the flow. Cron execution and email delivery are
 * covered by the Vitest suites (ScheduleRunService, scheduledReportRuns,
 * scheduledReportEmail), not here.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 120_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

async function openSchedules(page: Page, projectId: string) {
  await page.goto(`/p/${projectId}/reports`);
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  const panel = page.getByTestId("report-schedules-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  return panel;
}

async function createSchedule(
  page: Page,
  panel: ReturnType<Page["getByTestId"]>,
  cadence: "Weekly" | "Monthly",
) {
  // Let the initial list settle (loading → rows or empty guidance) before
  // counting; the shared dev database may already hold rows from other runs.
  await expect(panel.getByText("Loading schedules…")).toBeHidden({
    timeout: 30_000,
  });
  const rows = panel.locator("li");
  const before = await rows.count();
  await panel.getByRole("button", { name: "Schedule report" }).click();
  const modal = page.getByTestId("schedule-email-modal");
  await expect(modal).toBeVisible();
  await modal.getByLabel("Report type").selectOption("overview");
  await modal.getByLabel(cadence, { exact: true }).check();
  await modal.getByLabel("Recipients").fill("owner@example.com");
  await modal.getByRole("button", { name: "Save schedule" }).click();
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(before + 1);
  return rows.first();
}

test.describe("report schedules (spec 012)", () => {
  test("empty state shows setup guidance, distinct from the error state", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const panel = await openSchedules(page, projectId);
    // Honest states only: either setup guidance (no schedules) or rows —
    // never an error masquerading as content.
    await expect(
      panel.getByText(/No scheduled reports yet|Next run:/).first(),
    ).toBeVisible();
    await expect(panel.getByText("Something went wrong")).toBeHidden();
  });

  test("create via modal persists with derived next-due display", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const panel = await openSchedules(page, projectId);
    const row = await createSchedule(page, panel, "Weekly");
    await expect(row).toContainText("Weekly");
    await expect(row).toContainText("Next run:");
  });

  test("pause and resume reflect truthfully on next view", async ({ page }) => {
    const projectId = await getProjectId(page);
    const panel = await openSchedules(page, projectId);
    const row = await createSchedule(page, panel, "Monthly");
    await expect(row).toContainText("Monthly");

    await row.getByRole("button", { name: "Pause" }).click();
    await expect(row).toContainText("Paused", { timeout: 15_000 });
    await row.getByRole("button", { name: "Resume" }).click();
    await expect(row).not.toContainText("Paused", { timeout: 15_000 });
  });
});
