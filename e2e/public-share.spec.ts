import { expect, test } from "@playwright/test";

/**
 * Public share trust boundary (spec 005, quickstart scenarios 1–3).
 *
 * Anonymous-only assertions over the frozen trust boundary: the public route
 * is reachable outside the auth shell, every non-active token fails closed
 * with a distinguishable state, and the active-link UX degrades honestly.
 * Seed-dependent happy-path shares need a real report; the states asserted
 * here are the ones guaranteed without one (invalid → live resolution,
 * revoked/expired exercised by the ShareService lifecycle suite).
 */
test.describe("public share boundary", () => {
  test("invalid tokens fail closed with the invalid state", async ({
    request,
  }) => {
    // Malformed (not 64 hex chars) → invalid.
    const malformed = await request.get("/api/public-report?token=nope");
    expect(malformed.status()).toBe(404);
    expect(malformed.headers()["x-share-state"]).toBe("invalid");
    expect((await malformed.text()).length).toBeLessThan(200);

    // Well-formed but unknown hash → also invalid.
    const unknown = await request.get(
      `/api/public-report?token=${"a".repeat(64)}`,
    );
    expect(unknown.status()).toBe(404);
    expect(unknown.headers()["x-share-state"]).toBe("invalid");
    expect((await unknown.text()).length).toBeLessThan(200);
  });

  test("the public page shell renders without the app nav/session", async ({
    page,
  }) => {
    await page.goto(`/r/${"a".repeat(64)}`);
    // Outside the authenticated shell: no project sidebar/nav landmarks.
    await expect(page.getByText("Link unavailable")).toBeVisible({
      timeout: 15_000,
    });
    // The unavailability copy distinguishes states without internals.
    await expect(
      page.getByText(/invalid, expired, or revoked/i).first(),
    ).toBeVisible();
  });

  test("no-store caching on the public endpoint", async ({ request }) => {
    const response = await request.get("/api/public-report?token=nope");
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("valid public report link access and subsequent revocation lifecycle", async ({
    page,
    browser,
  }) => {
    await page.goto("/");
    await page.waitForURL(/\/p\/([^/]+)\/?$/, { timeout: 30_000 });
    const match = page.url().match(/\/p\/([^/]+)/);
    if (!match) throw new Error(`Could not read project id from ${page.url()}`);
    const projectId = match[1];

    await page.goto(`/p/${projectId}/reports`);
    await expect(
      page.getByRole("heading", { name: "Reports", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const openSnapshotBtn = page.getByRole("link", { name: "Open snapshot" });
    if ((await openSnapshotBtn.count()) === 0) {
      await page.getByRole("button", { name: "Generate report" }).click();
      const modal = page.locator(".modal.modal-open");
      await expect(modal).toBeVisible();
      await modal
        .getByRole("button", { name: "Generate", exact: true })
        .click();
      await expect(modal).toBeHidden({ timeout: 20_000 });
      await expect(openSnapshotBtn.first()).toBeVisible({ timeout: 20_000 });
    }

    await openSnapshotBtn.first().click();
    await page.waitForURL(new RegExp(`/p/${projectId}/reports/[^/]+`), {
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Share" }).click();
    const shareModal = page.locator(".modal.modal-open");
    await expect(shareModal).toBeVisible();

    await shareModal.getByRole("button", { name: "Create link" }).click();

    const successAlert = shareModal.locator(".alert-success");
    await expect(successAlert).toBeVisible({ timeout: 10_000 });
    const linkText = (
      await successAlert.locator("p.break-all").innerText()
    ).trim();
    expect(linkText).toMatch(/\/r\/[0-9a-f]{64}$/i);

    // In an isolated anonymous context (outside the authenticated app shell), verify access
    const incognito = await browser.newContext();
    const publicPage = await incognito.newPage();
    await publicPage.goto(linkText);

    await expect(publicPage.getByRole("heading", { level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    await expect(publicPage.getByText("Link unavailable")).toBeHidden();

    // Back on the authenticated page, revoke the link
    const activeLinksList = shareModal.locator("ul");
    await expect(activeLinksList).toBeVisible();
    const revokeBtn = activeLinksList
      .getByRole("button", { name: "Revoke" })
      .first();
    await revokeBtn.click();
    await expect(activeLinksList.getByText("Revoked").first()).toBeVisible({
      timeout: 10_000,
    });

    // Back on the incognito page, reload and assert revocation is enforced
    await publicPage.reload();
    await expect(publicPage.getByText("Link unavailable")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      publicPage.getByText(/invalid, expired, or revoked/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    await incognito.close();
  });
});
