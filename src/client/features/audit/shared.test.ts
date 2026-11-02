import { describe, expect, it } from "vitest";
import { extractHostname, extractPathname, formatDate, formatStartedAt } from "./shared";

describe("audit shared utilities", () => {
  it("extracts and decodes percent-encoded Arabic pathnames from absolute URLs", () => {
    const url = "https://hattricksa.com/%D9%85%D9%86%D8%AA%D8%AC%D8%A7%D8%AA-%D9%86%D8%A7%D8%AF%D9%8A%D8%A7";
    expect(extractPathname(url)).toBe("/منتجات-ناديا");
  });

  it("extracts and decodes relative percent-encoded paths", () => {
    const path = "/%D8%B9%D9%86-%D9%87%D8%AA%D8%AA%D8%B1";
    expect(extractPathname(path)).toBe("/عن-هتتر");
  });

  it("preserves standard ASCII paths unchanged", () => {
    expect(extractPathname("/-/c1532389616")).toBe("/-/c1532389616");
    expect(extractPathname("https://example.com/blog/author/123")).toBe(
      "/blog/author/123",
    );
  });

  it("extracts hostname from absolute URLs", () => {
    expect(extractHostname("https://hattricksa.com/products")).toBe(
      "hattricksa.com",
    );
  });

  it("formats dates and timestamps consistently", () => {
    expect(formatDate("2026-10-19 12:34:56")).toContain("2026");
    expect(formatStartedAt("2026-10-19 12:34:56")).toContain("Oct 19");
  });
});
