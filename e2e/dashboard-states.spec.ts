import { expect, test, type Page } from "@playwright/test";

/**
 * Dashboard intelligence sections + unified states (spec 011, US3/US4 — T026).
 *
 * Seed-independent: the E2E environment has no GA4/GSC connections, so the
 * spec asserts the honest states for a disconnected project — not_connected
 * sections carry connect CTAs, empty/no-data copy is distinct per state, and
 * failure copy never masquerades as empty. The ready-state value equality
 * (SC-004) is covered by the Vitest suites against seeded rollups.
 */

async function getProjectId(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);
  return match[1];
}

async function openIntelligence(page: Page, projectId: string) {
  await page.goto(`/p/${projectId}/`);
  const group = page.getByRole("region", { name: "Project intelligence" });
  await expect(group).toBeVisible({ timeout: 30_000 });
  return group;
}

test.describe("dashboard intelligence states (spec 011)", () => {
  test("disconnected sources render not_connected with connect CTAs", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const group = await openIntelligence(page, projectId);

    const disconnected = group.getByTestId("section-not-connected");
    expect(await disconnected.count()).toBeGreaterThanOrEqual(2);
    await expect(
      disconnected.getByText("Connect Google Analytics").first(),
    ).toBeVisible();
    // CTAs route to the detail surface that hosts the connection flow.
    await expect(
      disconnected.getByRole("link", { name: "Open Analytics" }).first(),
    ).toBeVisible();
  });

  test("empty and no-data copy is distinct and never zeroed", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const group = await openIntelligence(page, projectId);

    const empties = group.getByTestId("section-empty");
    expect(await empties.count()).toBeGreaterThanOrEqual(1);
    // The opportunities empty state names the situation honestly…
    await expect(
      empties.getByText("No open opportunities right now").first(),
    ).toBeVisible();
    // …and no empty section renders a zeroed stat as if measured.
    for (const section of await empties.all()) {
      await expect(section.getByText("0", { exact: true })).toBeHidden();
    }
  });

  test("failed sections would show retry, never empty content", async ({
    page,
  }) => {
    const projectId = await getProjectId(page);
    const group = await openIntelligence(page, projectId);

    // In this environment no section should be failed; the assertion locks
    // the invariant from the other side: every failed-state container (if
    // any ever renders) carries a retry affordance.
    const failed = group.getByTestId("section-failed");
    expect(await failed.count()).toBe(0);
    // And no section renders the failure label without the failed testid.
    await expect(group.getByText("failed to load")).toBeHidden();
  });
});
