import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  PLATFORM_CONFIDENCE_THRESHOLD,
} from "@/server/lib/audit/platform-detection";

const storePage = (extra: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Electronics store</title>
  <meta name="description" content="Powered by a storefront platform">
  ${extra}
</head>
<body>
  <main><h1>Electronics</h1><p>${"Product grid text ".repeat(20)}</p></main>
</body>
</html>`;

describe("detectPlatform", () => {
  it("stays undetected with no evidence", () => {
    const detection = detectPlatform({
      html: storePage(""),
      url: "https://example.com/",
    });
    expect(detection.platform).toBeNull();
    expect(detection.confidence).toBe(0);
    expect(detection.evidence).toEqual([]);
  });

  it("never detects on the hostname alone", () => {
    const detection = detectPlatform({
      html: storePage(""),
      url: "https://www.salla.sa/",
    });
    expect(detection.platform).toBeNull();
  });

  it("does not detect on a URL pattern alone — the weakest single source", () => {
    const detection = detectPlatform({
      html: storePage(""),
      url: "https://example.com/product/awesome-desk-lamp",
    });
    expect(detection.platform).toBeNull();
    expect(detection.confidence).toBeLessThan(PLATFORM_CONFIDENCE_THRESHOLD);
  });

  it("detects Salla from the meta generator alone", () => {
    const detection = detectPlatform({
      html: storePage('<meta name="generator" content="Salla E-Commerce">'),
      url: "https://example.com/",
    });
    expect(detection.platform).toBe("salla");
    expect(detection.confidence).toBeGreaterThanOrEqual(
      PLATFORM_CONFIDENCE_THRESHOLD,
    );
    expect(detection.evidence).toEqual([
      { source: "generator_meta", detail: "Salla E-Commerce" },
    ]);
  });

  it("detects Salla from platform asset hosts plus SDK globals", () => {
    const detection = detectPlatform({
      html: storePage(
        '<script src="https://cdn.salla.network/salla.v1.js" defer></script><script>window.salla.event.on("cart-add",fn)</script>',
      ),
      url: "https://example.com/",
    });
    expect(detection.platform).toBe("salla");
    expect(detection.confidence).toBe(1);
    expect(detection.evidence.map((e) => e.source)).toEqual([
      "asset_host",
      "global_object",
    ]);
  });

  it("corroborates a response header with a URL pattern", () => {
    const detection = detectPlatform({
      html: storePage(""),
      url: "https://example.com/category/accessories",
      headers: { "X-Salla-Page": "js" },
    });
    expect(detection.platform).toBe("salla");
    expect(detection.evidence.map((e) => e.source)).toEqual([
      "url_pattern",
      "response_header",
    ]);
  });

  it("corroborates SDK globals with an asset host, threshold-aware", () => {
    const detection = detectPlatform({
      html: storePage(
        '<link rel="preload" href="https://assets.salla.sa/fonts/salla-icons.css">',
      ),
      url: "https://example.com/",
    });
    // asset_host (0.6) alone is below the threshold.
    expect(detection.platform).toBeNull();

    const corroborated = detectPlatform({
      html: storePage(
        '<link rel="preload" href="https://assets.salla.sa/fonts/salla-icons.css"><script>var sallaConfig=salla.config.get();</script>',
      ),
      url: "https://example.com/",
    });
    expect(corroborated.platform).toBe("salla");
  });

  it("detects Salla when analyzeHtml fails but the markup is reachable", () => {
    const detection = detectPlatform({
      html: storePage('<meta name="generator" content="salla">'),
      url: "https://example.com/",
    });
    expect(detection.platform).toBe("salla");
  });

  it("skips HTML-based evidence when no HTML was read", () => {
    const detection = detectPlatform({
      html: null,
      url: "https://example.com/product/1",
      headers: {},
    });
    expect(detection.platform).toBeNull();
  });
});
