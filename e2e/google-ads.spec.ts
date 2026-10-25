import { expect, test, type Page } from "@playwright/test";

/**
 * Google Ads integration browser E2E verification.
 *
 * Exercises the Google Ads surface with deterministic fixtures:
 * 1. Honest disconnected state:
 *    - Renders the Google Ads heading and DB-first subtitle.
 *    - Renders the connection card with Not connected status.
 *    - Never fakes zeroed metrics or fabricated rows when disconnected.
 * 2. Connected, synced state via fixture headers:
 *    - Overview KPIs (spend, clicks, conversions, ROAS) with deltas.
 *    - Campaign/keyword/search-term/device/landing-page breakdown tables.
 *    - Privacy floor notice for search terms.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

test.describe("Google Ads browser E2E", () => {
  test("renders honest unavailable state when disconnected", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/google-ads`);

    // Heading & description
    await expect(
      page.getByRole("heading", { name: "Google Ads", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(
        /Campaign spend, clicks and conversions from synced read-only data/i,
      ),
    ).toBeVisible();

    // Honest disconnected connection card (either "Not connected" or self-hosted "Setup required")
    const connectCard = page
      .getByRole("heading", { name: "Google Ads" })
      .first();
    await expect(connectCard).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Not connected|Setup required/i).first(),
    ).toBeVisible();
    await expect(
      page
        .getByText(/Connect with Google|Google OAuth client not configured/i)
        .first(),
    ).toBeVisible();

    // Metrics are never zeroed or falsely populated when disconnected
    await expect(page.getByText("0 impressions")).toBeHidden();
    await expect(page.getByText("0 clicks")).toBeHidden();
  });

  test("renders connected performance data from synced fixtures", async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({
      "x-e2e-google-ads-fixture": "1",
    });

    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/google-ads`);

    // Heading
    await expect(
      page.getByRole("heading", { name: "Google Ads", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Toolbar
    await expect(page.getByLabel("Date range")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel("Search term filter")).toBeVisible();
    await expect(page.getByLabel("Campaign focus")).toBeVisible();

    // Overview KPI cards
    await expect(page.getByText("$6,120.45").first()).toBeVisible();
    await expect(page.getByText("184,200").first()).toBeVisible();
    await expect(page.getByText("12,340").first()).toBeVisible();
    await expect(page.getByText("486").first()).toBeVisible();
    await expect(page.getByText("5.00").first()).toBeVisible(); // "5.00x"

    // Equal-window delta chip
    await expect(page.getByText("+$309.85").first()).toBeVisible();

    // Breakdown tables
    const campaignsSection = page.getByRole("region", { name: "Campaigns" });
    await expect(
      campaignsSection.getByRole("cell", { name: "Brand Search — US" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      campaignsSection.getByRole("cell", { name: "Shopping Feed" }),
    ).toBeVisible();

    const keywordsSection = page.getByRole("region", { name: "Keywords" });
    await expect(
      keywordsSection.getByRole("cell", { name: "buy running shoes online" }),
    ).toBeVisible();

    const searchTermsSection = page.getByRole("region", {
      name: "Search terms",
    });
    await expect(
      searchTermsSection.getByRole("cell", { name: "cheap running shoes" }),
    ).toBeVisible();
    await expect(
      searchTermsSection.getByText(/floor, not a census/i),
    ).toBeVisible();

    const devicesSection = page.getByRole("region", { name: "Devices" });
    await expect(
      devicesSection.getByRole("cell", { name: "mobile" }),
    ).toBeVisible();

    const landingPagesSection = page.getByRole("region", {
      name: "Landing pages",
    });
    await expect(
      landingPagesSection.getByRole("cell", {
        name: "https://example.com/products/running-shoes",
      }),
    ).toBeVisible();

    // Sync status
    await expect(page.getByText("Sync now")).toBeVisible();
  });
});
