import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverUrls, parseRobotsTxt } from "@/server/lib/audit/discovery";

const ORIGIN = "https://example.com";

/**
 * Minimal fetch stub keyed by URL. Real Response objects provide
 * text()/headers/url semantics; `url` is overridden so redirect-following
 * code sees the final URL.
 */
const handlers = new Map<
  string,
  { status: number; location?: string; body?: string; contentType?: string }
>();

function stubResponse(
  url: string,
  status: number,
  body: string,
  contentType: string,
): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const handler = handlers.get(url);
  if (!handler) {
    return new Response("not found", { status: 404 });
  }
  if (handler.status >= 300 && handler.status < 400) {
    return new Response(null, {
      status: handler.status,
      headers: { location: handler.location ?? "" },
    });
  }
  return stubResponse(
    url,
    handler.status,
    handler.body ?? "",
    handler.contentType ?? "text/plain",
  );
});

beforeEach(() => {
  handlers.clear();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRobotsTxt", () => {
  it("allows everything when robots.txt is missing", () => {
    const robots = parseRobotsTxt(ORIGIN, null);
    expect(robots.isAllowed("https://example.com/anything")).toBe(true);
    expect(robots.sitemapUrls).toEqual([]);
  });

  it("respect disallow rules and collect sitemap declarations", () => {
    const robots = parseRobotsTxt(
      ORIGIN,
      "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n",
    );
    expect(robots.isAllowed("https://example.com/admin")).toBe(false);
    expect(robots.isAllowed("https://example.com/blog")).toBe(true);
    expect(robots.sitemapUrls).toEqual([`${ORIGIN}/sitemap.xml`]);
  });
});

describe("discoverUrls", () => {
  it("follows an apex→www redirect for robots.txt", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, {
      status: 301,
      location: "https://www.example.com/robots.txt",
    });
    handlers.set("https://www.example.com/robots.txt", {
      status: 200,
      body: "User-agent: *\nDisallow:\n",
    });
    // Default sitemap location missing → empty result, not an error.
    handlers.set(`${ORIGIN}/sitemap.xml`, { status: 404 });

    const { robotsText, coverage } = await discoverUrls(ORIGIN, 10);

    expect(robotsText).toContain("Disallow:");
    expect(coverage.robotsDeclaredSitemaps).toBe(0);
    expect(coverage.urlsFromSitemaps).toBe(0);
    expect(coverage.sitemapDocsFailed).toBe(1);
  });

  it("never follows discovery redirects to internal hosts (SSRF)", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, {
      status: 302,
      location: "http://192.168.1.1/robots.txt",
    });

    const { robotsText, coverage } = await discoverUrls(ORIGIN, 10);

    // Treated exactly like a missing robots.txt.
    expect(robotsText).toBeNull();
    expect(coverage.urlsFromSitemaps).toBe(0);
  });

  it("fan-ins nested sitemap indexes and reports coverage", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, {
      status: 200,
      body: "Sitemap: https://example.com/sitemap-index.xml\n",
    });
    handlers.set(`${ORIGIN}/sitemap.xml`, { status: 404 });
    handlers.set(`${ORIGIN}/sitemap-index.xml`, {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${ORIGIN}/sitemaps-pages.xml</loc></sitemap>
  <sitemap><loc>${ORIGIN}/sitemaps-products.xml</loc></sitemap>
</sitemapindex>`,
    });
    handlers.set(`${ORIGIN}/sitemaps-pages.xml`, {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/blog?q=1</loc></url>
  <url><loc>https://shop.example.com/p/1</loc></url>
  <url><loc>${ORIGIN}/about</loc></url>
</urlset>`,
    });
    handlers.set(`${ORIGIN}/sitemaps-products.xml`, {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/p/1</loc></url>
</urlset>`,
    });

    const { urls, coverage } = await discoverUrls(ORIGIN, 10);

    // Cross-origin sitemap entries and /sitemap.xml (404 doc) excluded;
    urls.sort();
    expect(urls).toEqual([
      `${ORIGIN}/about`,
      `${ORIGIN}/blog?q=1`,
      `${ORIGIN}/p/1`,
    ]);
    expect(coverage.robotsDeclaredSitemaps).toBe(1);
    // index + 2 children + the default /sitemap.xml probe (404 → failed).
    expect(coverage.sitemapDocsFetched).toBe(4);
    expect(coverage.sitemapDocsFailed).toBe(1);
    expect(coverage.urlsFromSitemaps).toBe(3);
    expect(coverage.sitemapDocCapReached).toBe(false);
    expect(coverage.urlCapReached).toBe(false);
  });

  it("treats a persistently timing-out sitemap as failed, honestly", async () => {
    handlers.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
    );

    const { urls, coverage } = await discoverUrls(ORIGIN, 10);

    expect(urls).toEqual([]);
    expect(coverage.sitemapDocsFetched).toBe(1);
    expect(coverage.sitemapDocsFailed).toBe(1);
    expect(coverage.sitemapDocsTimedOut).toBe(1);
  });

  it("marks the URL cap when sitemaps exceed the discovered-url budget", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, { status: 404 });
    const sitemapUrls = Array.from(
      { length: 520 },
      (_, i) => `  <url><loc>${ORIGIN}/p/${i}</loc></url>`,
    ).join("\n");
    handlers.set(`${ORIGIN}/sitemap.xml`, {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls}
</urlset>`,
    });

    // maxPages=1 → budget floor of 500 discovered URLs.
    const { urls, coverage } = await discoverUrls(ORIGIN, 1);

    expect(urls).toHaveLength(500);
    expect(coverage.urlCapReached).toBe(true);
    expect(coverage.urlsFromSitemaps).toBe(500);
  });

  it("marks the sitemap-document cap at 300 documents", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, { status: 404 });
    const nested = Array.from(
      { length: 310 },
      (_, i) => `  <sitemap><loc>${ORIGIN}/sm-${i}.xml</loc></sitemap>`,
    ).join("\n");
    handlers.set(`${ORIGIN}/sitemap.xml`, {
      status: 200,
      contentType: "application/xml",
      body: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${nested}
</sitemapindex>`,
    });
    for (let i = 0; i < 310; i++) {
      handlers.set(`${ORIGIN}/sm-${i}.xml`, {
        status: 200,
        contentType: "application/xml",
        body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/p/${i}</loc></url>
</urlset>`,
      });
    }

    const { coverage } = await discoverUrls(ORIGIN, 5000);

    expect(coverage.sitemapDocCapReached).toBe(true);
    // The cap is checked between concurrency batches (batch of 5), so the
    // count can overshoot the 300 budget by at most batch-size - 1.
    expect(coverage.sitemapDocsFetched).toBeGreaterThanOrEqual(300);
    expect(coverage.urlsFromSitemaps).toBeGreaterThanOrEqual(295);
  });

  it("accepts sitemaps served with a plain-text content type when the body looks like XML", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, { status: 404 });
    handlers.set(`${ORIGIN}/sitemap.xml`, {
      status: 200,
      contentType: "text/plain",
      body: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/about</loc></url>
</urlset>`,
    });

    const { urls } = await discoverUrls(ORIGIN, 10);
    expect(urls).toEqual([`${ORIGIN}/about`]);
  });

  it("rejects sitemap responses that are definitely not sitemap XML", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, { status: 404 });
    handlers.set(`${ORIGIN}/sitemap.xml`, {
      status: 200,
      contentType: "text/html",
      body: "<html><body>404 page</body></html>",
    });

    const { urls, coverage } = await discoverUrls(ORIGIN, 10);
    expect(urls).toEqual([]);
    expect(coverage.sitemapDocsFailed).toBe(1);
  });

  it("never fetches sitemap documents on foreign origins", async () => {
    handlers.set(`${ORIGIN}/robots.txt`, {
      status: 200,
      body: "Sitemap: https://evil.example.net/hotlink.xml\n",
    });
    handlers.set(`${ORIGIN}/sitemap.xml`, { status: 404 });

    const { urls, coverage } = await discoverUrls(ORIGIN, 10);

    expect(urls).toEqual([]);
    expect(coverage.sitemapDocsFetched).toBe(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("evil.example.net"),
    );
  });
});
