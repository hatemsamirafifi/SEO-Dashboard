import { describe, expect, it } from "vitest";
import { joinUrlEvidence, summarizeJoinCoverage } from "./AnalyticsJoinService";

describe("AnalyticsJoinService", () => {
  it("joins same-page cross-source rows via host context (spec 006)", () => {
    const rows = joinUrlEvidence({
      hostContext: "example.com",
      gsc: [
        {
          url: "https://example.com/guide?utm=x",
          clicks: 100,
          impressions: 1000,
        },
      ],
      ga4: [
        { landingPage: "/guide", currentSessions: 50, previousSessions: 80 },
      ],
      rank: [{ url: "http://www.example.com/guide/", worsened: true }],
    });
    // UTM variant, www/http/slash variants, and the GA4 path row (resolved
    // against the project host) all share one canonical identity.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe("https://example.com/guide");
    expect(rows[0]?.gscClicks).toBe(100);
    expect(rows[0]?.ga4Sessions).toEqual({ current: 50, previous: 80 });
    expect(rows[0]?.rankWorsened).toBe(true);
    expect(rows[0]?.present).toMatchObject({
      gsc: true,
      ga4: true,
      rank: true,
    });
  });

  it("keeps path-only rows path-scoped without host context (spec 006)", () => {
    const rows = joinUrlEvidence({
      gsc: [
        {
          url: "https://example.com/guide?utm=x",
          clicks: 100,
          impressions: 1000,
        },
      ],
      ga4: [
        { landingPage: "/guide", currentSessions: 50, previousSessions: 80 },
      ],
    });
    // No invented host: the GA4 path row cannot join the GSC full URL.
    const byUrl = Object.fromEntries(rows.map((row) => [row.url, row]));
    expect(byUrl["https://example.com/guide"]?.gscClicks).toBe(100);
    expect(byUrl["/guide"]?.ga4Sessions).toEqual({
      current: 50,
      previous: 80,
    });
    expect(byUrl["/guide"]?.present).toMatchObject({
      gsc: false,
      ga4: true,
      rank: false,
    });
  });

  it("sums duplicate witnesses and ORs rank flags", () => {
    const rows = joinUrlEvidence({
      gsc: [
        { url: "https://example.com/a", clicks: 10, impressions: 100 },
        { url: "https://example.com/a?x=1", clicks: 5, impressions: 50 },
      ],
      rank: [
        { url: "https://example.com/a", worsened: false },
        { url: "https://example.com/a", worsened: true },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe("https://example.com/a");
    expect(rows[0]?.gscClicks).toBe(15);
    expect(rows[0]?.rankWorsened).toBe(true);
    expect(rows[0]?.present).toMatchObject({
      gsc: true,
      ga4: false,
      rank: true,
    });
  });

  it("summarizes per-source join coverage", () => {
    const rows = joinUrlEvidence({
      gsc: [{ url: "https://example.com/a", clicks: 1, impressions: 1 }],
      ga4: [{ landingPage: "/b", currentSessions: 1, previousSessions: 2 }],
    });
    expect(summarizeJoinCoverage(rows)).toEqual({
      urlCount: 2,
      gscCovered: 1,
      ga4Covered: 1,
      rankCovered: 0,
    });
    expect(summarizeJoinCoverage([])).toMatchObject({ urlCount: 0 });
  });

  it("returns deterministic key order", () => {
    const rows = joinUrlEvidence({
      gsc: [
        { url: "https://example.com/z", clicks: 1, impressions: 1 },
        { url: "https://example.com/a", clicks: 1, impressions: 1 },
      ],
    });
    expect(rows.map((row) => row.url)).toEqual([
      "https://example.com/a",
      "https://example.com/z",
    ]);
  });
});
