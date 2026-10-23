import { expect, test, type Page } from "@playwright/test";

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

test.describe("internal linking report (spec 017)", () => {
  test("shows findings, suggestions, and hides export", async ({ page }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/audit?auditId=e2e-audit&tab=linking`);

    const view = page.getByTestId("internal-linking-view");
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText("Orphan candidates")).toBeVisible();
    await expect(view.getByText("Orphan widget")).toBeVisible();
    await expect(
      view.getByText("Suggested sources", { exact: true }),
    ).toBeVisible();
    await expect(
      view
        .getByTestId("linking-suggestion")
        .getByText("Widget buying guide", { exact: true }),
    ).toBeVisible();
    await expect(
      view.getByText("link-to-noindex-page", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /export/i })).toHaveCount(0);
  });

  test("suppresses absence findings on a partial crawl", async ({ page }) => {
    const projectId = await getProjectId(page);
    await page.goto(
      `/p/${projectId}/audit?auditId=e2e-audit-partial&tab=linking`,
    );

    await expect(page.getByTestId("internal-linking-view")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("linking-partial-coverage")).toBeVisible();
    await expect(page.getByText("Orphan widget")).toHaveCount(0);
    await expect(
      page.getByText("link-to-noindex-page", { exact: true }),
    ).toBeVisible();
  });
});
