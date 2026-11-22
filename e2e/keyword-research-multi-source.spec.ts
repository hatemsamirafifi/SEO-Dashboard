import { expect, test, type Page } from "@playwright/test";
import type { GlobalTraceOperation } from "../src/shared/globalTraceTypes";

async function openKeywordResearch(
  page: Page,
  keyword: string,
  country: number,
) {
  let projectId = process.env.OPENSEO_E2E_PROJECT_ID;
  if (!projectId) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/p\/[^/]+\/?$/);
    projectId = new URL(page.url()).pathname.split("/")[2];
  }
  await page.goto(
    `/p/${projectId}/keywords?q=${encodeURIComponent(keyword)}&loc=${country}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
}

test.describe("Arabic keyword research sources", () => {
  for (const viewport of [
    { width: 1440, height: 950 },
    { width: 390, height: 844 },
  ]) {
    test(`shows partial results and the trace at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const uncaught: string[] = [];
      page.on("pageerror", (error) => uncaught.push(error.message));
      await openKeywordResearch(page, "عطور عربية", 2682);

      const row = page.getByRole("row", { name: /عطور عربية اقتصادية/ });
      await expect(row).toBeVisible({ timeout: 25_000 });
      await expect(
        page.getByRole("dialog", {
          name: /One quick setup step|Set up DataForSEO/i,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByText(
          /setup needed.*DataForSEO|Add or update the DataForSEO key/i,
        ),
      ).toHaveCount(0);
      await expect(row.getByText(/18 site impressions/)).toBeVisible();
      await expect(row.getByText("18", { exact: true })).toHaveCount(0);
      await page
        .getByText("Partial results · Keyword sources", { exact: false })
        .click();
      await expect(
        page.getByText("Google Ads Keyword Planner · Rate limited"),
      ).toBeVisible();
      await expect(
        page.getByText(
          "SE Ranking (suggestions) · No matching opportunities · cached",
        ),
      ).toBeVisible();
      await expect(
        page.getByText(/this property appeared in Google Search/),
      ).toBeVisible();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem("openseo_global_trace_operations");
            const operations: GlobalTraceOperation[] = raw
              ? JSON.parse(raw)
              : [];
            return operations.find(
              (entry) =>
                entry.operation === "keyword_research.research" &&
                entry.status === "success",
            );
          }),
        )
        .toMatchObject({
          provider: "Search Console",
          providerCalls: 1,
          providers: expect.arrayContaining([
            expect.objectContaining({
              provider: "SE Ranking",
              statusMessage: "No matching opportunities · cached",
              dispatched: false,
            }),
            expect.objectContaining({
              provider: "Google Ads Keyword Planner",
              statusMessage: "Rate limited",
            }),
          ]),
        });
      expect(uncaught).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath("keyword-sources.png"),
        fullPage: true,
      });
      if (viewport.width > 1000) {
        await page
          .getByRole("button", { name: "Debug Trace", exact: true })
          .click();
        await page
          .getByRole("button", { name: /keyword_research\.research/ })
          .first()
          .click();
        await expect(
          page.getByText("Rate limited", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("No matching opportunities · cached", { exact: true }),
        ).toBeVisible();
      }
    });
  }

  test("fits the full Auto mode label at narrow mobile widths", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openKeywordResearch(page, "عطور عربية", 2682);
    const mode = page.locator("select").filter({
      has: page.getByRole("option", {
        name: "Auto (Recommended)",
        exact: true,
      }),
    });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(mode).toHaveValue("auto");
      const fits = await page.evaluate(() => {
        const element = document.querySelector('[aria-label="Research mode"]');
        if (!element) return false;
        const style = window.getComputedStyle(element);
        if (!(element instanceof HTMLSelectElement)) return false;
        const canvas = document.createElement("canvas").getContext("2d");
        if (!canvas) return false;
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = element.selectedOptions[0]?.text ?? "";
        const room =
          element.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return (
          text === "Auto (Recommended)" &&
          canvas.measureText(text).width <= room
        );
      });
      expect(fits, `Auto label fits at ${width}px`).toBe(true);
    }
  });

  test("shows an empty coverage state with per-source reasons in Egypt", async ({
    page,
  }) => {
    await openKeywordResearch(page, "عطور بلا نتائج", 2818);
    await expect(
      page.getByText("No matching keyword opportunities", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Google Ads Keyword Planner · Skipped"),
    ).toBeVisible();
    await expect(
      page.getByText("Search Console · No matching opportunities"),
    ).toBeVisible();
  });
});
