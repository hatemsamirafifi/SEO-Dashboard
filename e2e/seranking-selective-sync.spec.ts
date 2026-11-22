import { expect, test, type Locator, type Page } from "@playwright/test";

const projectId = "8814bf28-0081-48e6-8f07-a4774efe4d15";
const configId = "08cbc9b1-82b4-4b5b-984a-0f7e57f8296d";
const url = `/p/${projectId}/rank-tracking/${configId}`;
const existing = "إنشاء ملاعب كرة القدم";
const missing = "أرضيات ملاعب بادل";
const unselected = "ملاعب تنس خارجية";

test.use({ viewport: { width: 1512, height: 982 } });
test.setTimeout(120_000);

function row(page: Page, keyword: string) {
  return page.getByRole("row").filter({ hasText: keyword });
}

function stat(modal: Locator, label: string) {
  return modal.getByText(label, { exact: true }).locator("..");
}

async function selectKeywords(page: Page) {
  await page.goto(url);
  await expect(row(page, missing)).toContainText("Not Synced", {
    timeout: 45_000,
  });
  const action = page.getByRole("button", {
    name: "Add Selected to SE Ranking",
  });
  await expect(action).toBeHidden();
  await row(page, existing).getByRole("checkbox").check();
  await row(page, missing).getByRole("checkbox").check();
  await expect(row(page, unselected).getByRole("checkbox")).not.toBeChecked();
  await expect(action).toBeVisible();
  return action;
}

async function openSelectedPreview(page: Page, action: Locator) {
  await action.click();
  const modal = page.getByRole("dialog");
  await expect(modal).toContainText("13188608", { timeout: 45_000 });
  await expect(modal).toContainText("Matchday Sports");
  await expect(stat(modal, "Selected keywords")).toContainText("2");
  await expect(stat(modal, "Already remote")).toContainText("1");
  await expect(stat(modal, "Missing remotely")).toContainText("1");
  await expect(modal.getByText(unselected)).toBeHidden();
  return modal;
}

test("preview reads the linked project and supports explicit all-missing review", async ({
  page,
}, testInfo) => {
  const action = await selectKeywords(page);
  await page.screenshot({
    path: testInfo.outputPath("rank-tracking-bulk-action.png"),
    animations: "disabled",
  });
  const modal = await openSelectedPreview(page, action);
  await expect(stat(modal, "Missing Desktop")).toContainText("1");
  await expect(stat(modal, "Missing Mobile")).toContainText("1");
  await modal.getByRole("button", { name: "Both", exact: true }).click();
  await expect(stat(modal, "Missing Mobile")).toContainText("2");
  await page.screenshot({
    path: testInfo.outputPath("rank-tracking-sync-confirmation.png"),
    animations: "disabled",
  });
  await modal.getByRole("button", { name: "Cancel" }).click();

  await page.getByTitle("More actions", { exact: true }).click();
  await page
    .getByText("Sync all missing keywords to SE Ranking", { exact: true })
    .click();
  await expect(modal).toContainText(unselected, { timeout: 45_000 });
  await modal.getByRole("button", { name: "Cancel" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 390) + (bounds?.width ?? 390)).toBeLessThanOrEqual(390);
});

test("confirmed sync adds only the missing selection and repairs existing assignments", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const action = await selectKeywords(page);
  await expect(
    row(page, existing).getByText("#6", { exact: true }),
  ).toBeVisible();
  const modal = await openSelectedPreview(page, action);
  await modal.getByRole("button", { name: "Both", exact: true }).click();
  await modal
    .getByRole("button", { name: "Confirm — Add Missing Keywords" })
    .click();
  await expect(stat(modal, "Keywords added")).toContainText("1", {
    timeout: 60_000,
  });
  await expect(stat(modal, "Engine assignments updated")).toContainText("1");
  await expect(stat(modal, "Mappings repaired")).toContainText("1");
  await expect(stat(modal, "Failed")).toContainText("0");
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    row(page, existing).getByText("#6", { exact: true }),
  ).toBeVisible();
  await expect(
    row(page, missing).getByText("Synced", { exact: true }),
  ).toBeVisible();
  await expect(row(page, unselected)).toContainText("Not Synced");
  expect(pageErrors).toEqual([]);
});
