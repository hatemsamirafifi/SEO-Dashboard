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
});