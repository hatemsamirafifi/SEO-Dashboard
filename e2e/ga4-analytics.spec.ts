import { expect, test, type Page } from "@playwright/test";

/**
 * GA4 Advanced Analytics browser E2E verification.
 *
 * Exercises the complete GA4 surface:
 * 1. Honest unavailable / disconnected state:
 *    - Renders the Analytics heading and DB-first subtitle.
 *    - Renders the honest AnalyticsConnectionCard with Not Connected status.
 *    - Never fakes zeroed metrics or fabricated empty charts when disconnected.
 * 2. Stored dimensions and interactive views:
 *    - Filter toolbar (Date range, Channel filter, Device filter, Country filter).
 *    - Stored dimension sections (Overview, Acquisition, Landing pages, Geography).
 *    - Technology section dimension switcher: interactive switching between
 *      Device, Browser, and Operating system breakdowns.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

test.describe("GA4 analytics browser E2E", () => {
  test("renders honest unavailable state when disconnected", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/analytics`);

    // Heading & description
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/Google Analytics 4 traffic, read from synced data/i),
    ).toBeVisible();

    // Honest disconnected state card
    const connectHeading = page.getByRole("heading", {
      name: "Google Analytics 4",
    });
    await expect(connectHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Not connected").first()).toBeVisible();
    await expect(
      page.getByText(/Select a read-only Analytics property/i),
    ).toBeVisible();

    // Metrics are never zeroed or falsely populated when disconnected
    await expect(page.getByText("0 sessions")).toBeHidden();
    await expect(page.getByText("0 users")).toBeHidden();
  });

  test("renders stored dimensions, toolbar, and technology dimension switcher", async ({
    page,
  }) => {
    // Enable fixture headers for stored analytics dimensions
    await page.setExtraHTTPHeaders({
      "x-e2e-ga4-fixture": "1",
    });

    const projectId = await getProjectId(page);
    await page.goto(`/p/${projectId}/analytics`);

    // Verify heading
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Verify filter toolbar rendering
    await expect(page.getByLabel("Date range")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel("Channel filter")).toBeVisible();
    await expect(page.getByLabel("Device filter")).toBeVisible();
    await expect(page.getByLabel("Country filter")).toBeVisible();

    // Verify stored overview metrics
    await expect(page.getByText("14,200").first()).toBeVisible();
    await expect(page.getByText("35,400").first()).toBeVisible();

    // Verify Acquisition section
    const acqHeading = page.getByRole("heading", {
      name: "Acquisition",
      exact: true,
    });
    await expect(acqHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Organic Search").first()).toBeVisible();
    await expect(page.getByText("Direct").first()).toBeVisible();

    // Verify Geography section
    const geoHeading = page.getByRole("heading", {
      name: "Geography",
      exact: true,
    });
    await expect(geoHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Egypt").first()).toBeVisible();
    await expect(page.getByText("United States").first()).toBeVisible();

    // Verify Technology section and dimension switching
    const techRegion = page.getByRole("region", { name: "Technology" });
    await expect(
      techRegion.getByRole("heading", { name: "Technology", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Default dimension: Device
    await expect(
      techRegion.getByRole("cell", { name: "desktop" }),
    ).toBeVisible();
    await expect(
      techRegion.getByRole("cell", { name: "mobile" }),
    ).toBeVisible();

    // Switch to Browser dimension
    const browserBtn = page.getByRole("button", { name: "Browser" });
    await expect(browserBtn).toBeVisible();
    await browserBtn.click();
    await expect(techRegion.getByRole("cell", { name: "Chrome" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      techRegion.getByRole("cell", { name: "Safari" }),
    ).toBeVisible();

    // Switch to Operating system dimension
    const osBtn = page.getByRole("button", { name: "Operating system" });
    await expect(osBtn).toBeVisible();
    await osBtn.click();
    await expect(techRegion.getByRole("cell", { name: "Windows" })).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      techRegion.getByRole("cell", { name: "Android" }),
    ).toBeVisible();

    // Verify Landing pages section
    const landingHeading = page.getByRole("heading", {
      name: "Landing pages",
      exact: true,
    });
    await expect(landingHeading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("/products/widgets").first()).toBeVisible();
    await expect(page.getByText("/blog/seo-guide").first()).toBeVisible();
  });
});
