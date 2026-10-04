import { expect, test, type Page } from "@playwright/test";

/**
 * Opportunities filters + analytics honest states (spec 010, quickstart V4
 * minus seed-dependent flows).
 *
 * Seed-independent assertions only: the filter controls render, a filter
 * combination with no matches shows the explicit filtered-empty state
 * (distinct from the project-empty explainer), and clearing restores. The
 * analytics page renders its heading plus whichever honest state the
 * environment holds (connection card without GA4, toolbar with it).
 *
 * Seed-dependent happy paths (goal CRUD driving a filtered conversions view,
 * detector-emitted opportunities triaged by the new filters) need a connected
 * GA4 property with synced grains; they are covered by the Vitest suites
 * (Ga4GoalService, AnalyticsService, detector fixtures, repository filter
 * matrix) until a GA4 E2E fixture flag exists.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, {
    timeout: 30_000,
  });

  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

test.describe("opportunities filters (spec 010)", () => {
  test("filter controls render for all six server dimensions", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/opportunities`);
    await expect(
      page.getByRole("heading", { name: "Opportunities", exact: true }),
    ).toBeVisible();

    await expect(
      page.getByRole("tablist", { name: "Filter by status" }),
    ).toBeVisible();
    await expect(page.getByLabel("Filter by type")).toBeVisible();
    await expect(page.getByLabel("Filter by priority")).toBeVisible();
    await expect(page.getByLabel("Filter by source")).toBeVisible();
    await expect(page.getByLabel("Filter by page (exact match)")).toBeVisible();
    await expect(
      page.getByLabel("Filter by keyword (exact match)"),
    ).toBeVisible();
    await expect(page.getByLabel("Search opportunities")).toBeVisible();
  });

  test("a no-match filter shows filtered-empty, distinct from project-empty", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/opportunities`);
    await expect(
      page.getByRole("heading", { name: "Opportunities", exact: true }),
    ).toBeVisible();

    // A page value that cannot exist: the server returns zero rows.
    await page
      .getByLabel("Filter by page (exact match)")
      .fill("https://example.com/never-a-real-page-010");
    await expect(
      page.getByRole("heading", { name: "No matches", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No opportunities yet")).toBeHidden();

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    // After clearing, either the project list or the project-empty
    // explainer shows — never the filtered-empty state.
    await expect(
      page.getByRole("heading", { name: "No matches", exact: true }),
    ).toBeHidden();
  });

  test("source filter options cover the evidence vocabulary", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/opportunities`);
    const source = page.getByLabel("Filter by source");
    await expect(source).toBeVisible();
    const options = await source.locator("option").allTextContents();
    for (const label of [
      "All sources",
      "Search Console",
      "Analytics",
      "Rank tracking",
      "Site audit",
      "Backlinks",
    ]) {
      expect(options).toContain(label);
    }
  });
});

test.describe("analytics honest states (spec 010)", () => {
  test("analytics page renders its heading plus one honest state", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/analytics`);
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // Exactly one honest state: not-connected card, empty explainer, or the
    // filter toolbar when GA4 is connected with coverage.
    const connectionCard = page.getByText(/connect.*property/i);
    const toolbar = page.getByLabel("Date range");
    const emptyNote = page.getByText("No Analytics data yet");
    await expect(connectionCard.or(toolbar).or(emptyNote).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
