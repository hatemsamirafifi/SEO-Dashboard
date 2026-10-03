import { expect, test, type Page } from "@playwright/test";

/**
 * SERP mobile card view (spec 011, US2 — T017).
 *
 * Runs against the E2E fixture branch of getSerpAnalysis (VITE_E2E_KEYWORD_FIXTURES=1):
 * a deterministic analysis with 3 organic rows (one enrichment-failed), a
 * placement-2 PAA block with 10 questions, and a local pack. Seed-independent
 * beyond the standard keyword fixtures: researching any keyword auto-triggers
 * the analysis for that keyword.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

async function openMobileSerp(page: Page, projectId: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/p/${projectId}/keywords?q=keyword%20research&loc=2840&kLimit=150&mode=auto`,
  );
  // The mobile page defaults to the keywords tab: switch to the SERP tab.
  // The fixture analysis auto-runs for the searched keyword; the mobile card
  // container appears once rows resolve.
  await page.getByRole("button", { name: "SERP Analysis" }).click();
  const panel = page.getByTestId("serp-mobile-tab-panel");
  await expect(panel.getByTestId("serp-results-mobile")).toBeVisible({
    timeout: 30_000,
  });
  return panel;
}

test.describe("SERP mobile card view (spec 011)", () => {
  test("cards show position, result, and summary with no horizontal overflow", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const container = await openMobileSerp(page, projectId);
    const cards = container.getByTestId("serp-result-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText("1");
    await expect(cards.nth(0)).toContainText("Fixture top result");
    await expect(cards.nth(0)).toContainText("Fixture summary one.");

    // Measure the VISIBLE (mobile-tab) container, not the desktop-hidden twin.
    const mobileBox = container.getByTestId("serp-results-mobile");
    const overflow = await mobileBox.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(overflow.docOverflow).toBeLessThanOrEqual(1);
  });

  test("metrics appear only after expansion; PAA card stays bounded", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const container = await openMobileSerp(page, projectId);
    // Scope to the mobile cards container: the panel also holds the
    // desktop-hidden table with the same metric text and feature blocks.
    const mobile = container.getByTestId("serp-results-mobile");
    await expect(mobile.getByText("DR 42")).toBeHidden();
    await mobile
      .getByTestId("serp-result-card")
      .nth(0)
      .getByTestId("serp-card-expand")
      .click();
    await expect(mobile.getByText("DR 42")).toBeVisible();

    const paa = mobile.getByTestId("serp-feature-block-peopleAlsoAsk");
    await expect(paa).toContainText("People Also Ask");
    const box = await paa.boundingBox();
    expect(box).not.toBeNull();
    // Ten questions stay inside a bounded card, never stretching the page.
    expect(box!.height).toBeLessThanOrEqual(420);
  });

  test("enrichment failure annotates without hiding results or features", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const container = await openMobileSerp(page, projectId);
    const mobile = container.getByTestId("serp-results-mobile");
    const failed = mobile.getByTestId("serp-result-card").nth(2);
    await expect(failed).toContainText("Fixture third result");
    await expect(failed.getByText(/unavailable|failed/i)).toBeVisible();
    await expect(
      mobile.getByTestId("serp-feature-block-localPack"),
    ).toBeVisible();
  });
});
