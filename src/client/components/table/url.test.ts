import { describe, expect, it } from "vitest";
import { formatUrlForDisplay, resolveUrlHref, safeDecodeUrlText } from "./url";

describe("table URL helpers", () => {
  it("formats URLs without scroll-to-text fragments", () => {
    expect(
      formatUrlForDisplay("https://example.com/a%20b?q=one#:~:text=needle"),
    ).toBe("https://example.com/a b?q=one");
  });

  it("keeps normal hashes and query strings in display labels", () => {
    expect(formatUrlForDisplay("https://example.com/path?q=1#section")).toBe(
      "https://example.com/path?q=1#section",
    );
  });

  it("decodes percent-encoded Arabic URLs in formatUrlForDisplay", () => {
    expect(
      formatUrlForDisplay(
        "https://example.com/%D9%85%D9%86%D8%AA%D8%AC%D8%A7%D8%AA?page=1",
      ),
    ).toBe("https://example.com/منتجات?page=1");
  });

  it("safeDecodeUrlText handles non-URL text and malformed escapes gracefully", () => {
    expect(safeDecodeUrlText("15% drop in sessions")).toBe(
      "15% drop in sessions",
    );
    expect(safeDecodeUrlText("%D8%B9%D9%86")).toBe("عن");
    expect(safeDecodeUrlText(null)).toBe("");
  });

  it("falls back to raw display text for invalid URLs", () => {
    expect(formatUrlForDisplay("/relative/path")).toBe("/relative/path");
  });

  it("resolves relative URLs against a base domain", () => {
    expect(resolveUrlHref("/pricing", "example.com")).toBe(
      "https://example.com/pricing",
    );
    expect(resolveUrlHref("docs", "example.com")).toBe(
      "https://example.com/docs",
    );
  });

  it("rejects unsafe absolute URL schemes", () => {
    expect(resolveUrlHref("javascript:alert(1)", "example.com")).toBeNull();
  });
});
