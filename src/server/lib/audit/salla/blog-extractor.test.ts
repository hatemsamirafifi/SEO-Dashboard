import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { extractBlog } from "./blog-extractor";

function load(html: string): CheerioAPI {
  return cheerio.load(html);
}

describe("extractBlog", () => {
  it("extracts title, dates and author from JSON-LD", () => {
    const blog = extractBlog({
      pageUrl: "https://store.sa/blog/woven",
      pageType: "blog",
      structuredDataJson: JSON.stringify({
        "@type": "BlogPosting",
        headline: "How Berber Rugs Are Woven",
        datePublished: "2026-05-01",
        dateModified: "2026-09-14",
        author: { "@type": "Person", name: "Amina" },
      }),
      bodyText: "",
      h1s: [],
      title: "Wrong page title",
      internalLinks: [],
      $: load("<html><body></body></html>"),
    });
    expect(blog.title).toEqual({
      value: "How Berber Rugs Are Woven",
      from: "structured-data",
    });
    expect(blog.datePublished?.value).toBe("2026-05-01");
    expect(blog.dateModified?.value).toBe("2026-09-14");
    expect(blog.author?.value).toBe("Amina");
  });

  it("falls back to article meta markup and html title, never to text mining", () => {
    const blog = extractBlog({
      pageUrl: "https://store.sa/blog/woven",
      pageType: "blog",
      structuredDataJson: null,
      bodyText: "Published on May 1st 2026 by Amina",
      h1s: ["سجاد: رحلة الخياطة"],
      title: "سجاد: رحلة الخياطة — المدونة",
      internalLinks: [],
      $: load(
        '<html><head><meta property="article:published_time" content="2026-05-01T09:00:00Z"></head><body></body></html>',
      ),
    });
    expect(blog.title).toEqual({
      value: "سجاد: رحلة الخياطة",
      from: "html",
    });
    expect(blog.datePublished?.value).toBe("2026-05-01T09:00:00Z");
    expect(blog.dateModified).toBeNull();
    expect(blog.author).toBeNull();
  });

  it("stays null when neither JSON-LD nor titles exist", () => {
    const blog = extractBlog({
      pageUrl: "https://store.sa/blog/woven",
      pageType: "blog",
      structuredDataJson: null,
      bodyText: "",
      h1s: [],
      title: "",
      internalLinks: [],
      $: load("<html><body></body></html>"),
    });
    expect(blog.title).toBeNull();
    expect(blog.datePublished).toBeNull();
    expect(blog.author).toBeNull();
  });
});
