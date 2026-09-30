import { describe, expect, it } from "vitest";
import { canonicalGa4Dimension, normalizeGa4LandingPage } from "./ga4";

describe("canonicalGa4Dimension", () => {
  it("passes through trimmed verbatim values", () => {
    expect(canonicalGa4Dimension("Organic Search")).toBe("Organic Search");
    expect(canonicalGa4Dimension("  google  ")).toBe("google");
  });

  it("maps null, undefined, and blank to the sentinel", () => {
    expect(canonicalGa4Dimension(null)).toBe("(not set)");
    expect(canonicalGa4Dimension(undefined)).toBe("(not set)");
    expect(canonicalGa4Dimension("   ")).toBe("(not set)");
  });
});

describe("normalizeGa4LandingPage", () => {
  it("strips query strings and fragments", () => {
    expect(normalizeGa4LandingPage("/pricing?utm_source=google#top")).toBe(
      "/pricing",
    );
  });

  it("ensures a leading slash on bare paths", () => {
    expect(normalizeGa4LandingPage("pricing")).toBe("/pricing");
  });

  it("keeps the root path and preserves case and trailing slashes", () => {
    expect(normalizeGa4LandingPage("/?utm_medium=email")).toBe("/");
    expect(normalizeGa4LandingPage("/Blog/Post/")).toBe("/Blog/Post/");
  });

  it("locks strict path semantics for GA4 sync storage (spec 006)", () => {
    // The analytical page identity (canonicalUrl) folds slashes and hosts.
    // This strict normalizer must NOT: GA4 stored fact keys are derived from
    // its output, so any change here would rewrite stored history.
    expect(normalizeGa4LandingPage("/a//b")).toBe("/a//b");
    expect(normalizeGa4LandingPage("/Blog/Post")).toBe("/Blog/Post");
    expect(normalizeGa4LandingPage("HTTPS://example.com/Page")).toBe(
      "/HTTPS://example.com/Page",
    );
  });

  it("maps null, undefined, and blank to the sentinel", () => {
    expect(normalizeGa4LandingPage(null)).toBe("(not set)");
    expect(normalizeGa4LandingPage(undefined)).toBe("(not set)");
    expect(normalizeGa4LandingPage("?utm_source=x")).toBe("(not set)");
  });
});
