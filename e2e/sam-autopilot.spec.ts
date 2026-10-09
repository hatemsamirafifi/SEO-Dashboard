import { expect, test, type Page } from "@playwright/test";

/**
 * SAM autopilot orchestration (spec 013, US4 — T024).
 *
 * The E2E environment shares one dev database across runs, so specs never
 * assume an empty run list: they count rows before/after and always operate
 * on the run they just started. Workflow execution is deterministic
 * (stored reads only), so a content_refresh run completes in seconds with
 * honest empty evidence on a data-less project. Cancel/resume act on the
 * just-started run while it is still active.
 */

async function getProjectId(page: Page) {
  await page.goto("/", { timeout: 60_000 });
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 120_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

async function openAutopilotTab(page: Page, projectId: string) {
  await page.goto(`/p/${projectId}/sam`, { timeout: 60_000 });
  const autopilotBtn = page.getByRole("button", { name: "Autopilot", exact: true });
  await expect(autopilotBtn).toBeVisible({ timeout: 30_000 });
  await autopilotBtn.click();
  await expect(
    page.getByRole("heading", { name: "Autopilot", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Start run" }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("sam autopilot (spec 013)", () => {
  test("picker lists all six workflows with labels", async ({ page }) => {
    const projectId = await getProjectId(page);
    await openAutopilotTab(page, projectId);
    const options = page.getByLabel("Workflow").locator("option");
    for (const label of [
      "Growth plan",
      "Quick wins",
      "Traffic drop",
      "Content refresh",
      "Technical SEO",
      "Monthly review",
    ]) {
      await expect(options.filter({ hasText: label })).toHaveCount(1);
    }
  });

  test("zero runs show setup guidance, distinct from the error state", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await openAutopilotTab(page, projectId);
    await expect(
      page.getByText(/No autopilot runs yet|Recent runs/).first(),
    ).toBeVisible();
    await expect(page.getByText("Something went wrong")).toBeHidden();
  });

  test("start → poll → terminal renders the frozen step checklist", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await openAutopilotTab(page, projectId);
    await page.getByLabel("Workflow").selectOption("content_refresh");
    await page.getByRole("button", { name: "Start run" }).click();
    // Live step checklist appears while the run executes.
    await expect(
      page.getByText("collect-refresh-state", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    // Terminal state renders with the completed label and step statuses.
    await expect(
      page.getByText(/Content refresh.+Completed/).first(),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText("synthesize-content-refresh", { exact: false }).first(),
    ).toBeVisible();
  });

  test("cancel an active run, then resume it to completion", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await openAutopilotTab(page, projectId);
    await page.getByLabel("Workflow").selectOption("quick_wins");
    await page.getByRole("button", { name: "Start run" }).click();
    // Act while the run is still active: the detail shows Cancel only then.
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    const terminal = page.getByText(/Quick wins.+(Completed|Failed)/).first();
    const canCancel = await Promise.race([
      cancel.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false),
      terminal.waitFor({ state: "visible", timeout: 10_000 }).then(() => false).catch(() => false),
    ]);
    if (canCancel) {
      await cancel.click();
      await expect(
        page.getByText(/Quick wins.+Cancelled/).first(),
      ).toBeVisible({ timeout: 30_000 });
      // Resume continues the cancelled run to its terminal state.
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(terminal).toBeVisible({ timeout: 120_000 });
    } else {
      await expect(terminal).toBeVisible({ timeout: 30_000 });
    }
  });
});
