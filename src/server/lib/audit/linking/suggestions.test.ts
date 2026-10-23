import { describe, expect, it } from "vitest";
import { suggestSources } from "./suggestions";
import { makeLinkingPage } from "./test-fixtures";

describe("suggestSources", () => {
  const target = makeLinkingPage({
    id: "target",
    url: "https://example.com/widget-guide",
    title: "Widget guide",
    h1Text: "Widget guide",
  });

  it("ranks H1 overlap above title overlap and caps the result", () => {
    const pages = [
      makeLinkingPage({
        id: "title-only",
        url: "https://example.com/title-only",
        title: "Widget guide",
      }),
      makeLinkingPage({
        id: "h1-only",
        url: "https://example.com/h1-only",
        h1Text: "Widget guide",
      }),
      makeLinkingPage({
        id: "third",
        url: "https://example.com/third",
        title: "Widget guide",
      }),
      makeLinkingPage({
        id: "fourth",
        url: "https://example.com/fourth",
        title: "Widget guide",
      }),
    ];

    const suggestions = suggestSources({
      target,
      pages,
      existingSourceUrls: new Set(),
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].sourceUrl).toBe("https://example.com/h1-only");
    expect(suggestions[0].score).toBe(8);
  });

  it("excludes the target, existing sources, utility pages, and no-match pages", () => {
    const pages = [
      target,
      makeLinkingPage({
        id: "existing",
        url: "https://example.com/existing",
        title: "Widget guide",
      }),
      makeLinkingPage({
        id: "cart",
        url: "https://example.com/cart",
        title: "Widget guide",
      }),
      makeLinkingPage({
        id: "unrelated",
        url: "https://example.com/unrelated",
        title: "Shipping policy",
      }),
    ];

    const suggestions = suggestSources({
      target,
      pages,
      existingSourceUrls: new Set(["https://example.com/existing"]),
    });

    expect(suggestions).toEqual([]);
  });
});
