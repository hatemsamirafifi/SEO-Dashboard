import { expect, test, type Page } from "@playwright/test";

/**
 * Schema editor flow (spec 016, SC-005).
 *
 * Uses the audit E2E fixtures: an audit with one product page (existing
 * markup differs from the proposal) and one blog page (proposal adds
 * properties). Verifies availability, diff gating, copy and export.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

async function openPagesTab(page: Page, projectId: string) {
  await page.goto(`/p/${projectId}/audit?auditId=e2e-audit&tab=pages`);
  await expect(page.getByRole("table").first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("schema editor (spec 016)", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("product proposal requires review, then copies and exports", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await openPagesTab(page, projectId);

    const productRow = page
      .getByRole("row")
      .filter({ hasText: "/products/widget" });
    await productRow.getByTestId("schema-open").click();

    const modal = page.getByTestId("schema-editor");
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Schema editor")).toBeVisible();

    const productType = modal.getByTestId("schema-type-Product");
    await expect(productType).toBeEnabled();
    await expect(modal.getByTestId("schema-type-Article")).toBeDisabled();
    await expect(modal.getByTestId("schema-json")).toHaveCount(0);

    await productType.click();

    await expect(modal.getByTestId("schema-json")).toContainText(
      '"@type": "Product"',
    );
    const diff = modal.getByTestId("schema-diff");
    await expect(diff).toBeVisible();
    await expect(diff.getByText("offers.price")).toBeVisible();
    await expect(diff.getByText("changed", { exact: true })).toBeVisible();

    const copy = modal.getByTestId("schema-copy");
    const exportButton = modal.getByTestId("schema-export");
    await expect(copy).toBeDisabled();
    await expect(exportButton).toBeDisabled();

    await modal.getByTestId("schema-confirm").check();
    await expect(copy).toBeEnabled();
    await expect(exportButton).toBeEnabled();

    await copy.click();
    await expect(page.getByText("JSON-LD copied.")).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('"@type": "Product"');
    expect(clipboard).toContain('"price": "19.00"');

    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("schema-product-widget.json");

    await modal.getByTestId("schema-close").click();
    await expect(modal).toHaveCount(0);
  });

  test("added-only proposal exports without a confirmation gate", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    await openPagesTab(page, projectId);

    const blogRow = page
      .getByRole("row")
      .filter({ hasText: "/blog/launch-guide" });
    await blogRow.getByTestId("schema-open").click();

    const modal = page.getByTestId("schema-editor");
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("schema-type-Product")).toBeDisabled();

    await modal.getByTestId("schema-type-Article").click();

    await expect(modal.getByTestId("schema-json")).toContainText(
      '"@type": "Article"',
    );
    await expect(modal.getByTestId("schema-confirm")).toHaveCount(0);
    await expect(modal.getByTestId("schema-copy")).toBeEnabled();
    await expect(modal.getByTestId("schema-export")).toBeEnabled();
  });
});
