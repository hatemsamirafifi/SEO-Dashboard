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
      ga4EngagementCovered: 0,
      ga4GoalCovered: 0,
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

  it("merges engagement and goal witnesses per canonical page (spec 010)", () => {
    const rows = joinUrlEvidence({
      hostContext: "example.com",
      gsc: [{ url: "https://example.com/guide", clicks: 40, impressions: 400 }],
      ga4: [
        {
          landingPage: "/guide",
          currentSessions: 100,
          previousSessions: 50,
          currentEngagedSessions: 60,
          previousEngagedSessions: 40,
          currentGoalConversions: 12,
          previousGoalConversions: 20,
        },
      ],
      rank: [{ url: "https://example.com/guide", worsened: false }],
    });
    expect(rows).toHaveLength(1);
    // Engagement rate is a ratio-of-sums: 60/100 and 40/50.
    expect(rows[0]?.ga4Engagement).toEqual({
      currentRate: 0.6,
      previousRate: 0.8,
      currentEngagedSessions: 60,
      previousEngagedSessions: 40,
    });
    expect(rows[0]?.ga4GoalConversions).toEqual({ current: 12, previous: 20 });
    expect(summarizeJoinCoverage(rows)).toMatchObject({
      urlCount: 1,
      ga4EngagementCovered: 1,
      ga4GoalCovered: 1,
    });
  });

  it("keeps engagement and goal measures null when absent (spec 010)", () => {
    const rows = joinUrlEvidence({
      gsc: [{ url: "https://example.com/a", clicks: 1, impressions: 1 }],
      ga4: [{ landingPage: "https://example.com/a", currentSessions: 5, previousSessions: 6 }],
    });
    expect(rows).toHaveLength(1);
    // No engagement/goal witnesses passed: null — never fabricated zeros.
    expect(rows[0]?.ga4Engagement).toBeNull();
    expect(rows[0]?.ga4GoalConversions).toBeNull();
    expect(rows[0]?.ga4Sessions).toEqual({ current: 5, previous: 6 });
  });

  it("renders zero-session engagement as null, not zero (spec 010)", () => {
    const rows = joinUrlEvidence({
      ga4: [
        {
          landingPage: "https://example.com/a",
          currentSessions: 0,
          previousSessions: 0,
          currentEngagedSessions: 0,
          previousEngagedSessions: 0,
          currentGoalConversions: 0,
          previousGoalConversions: 0,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    // 0/0 is undefined engagement — null, not 0.
    expect(rows[0]?.ga4Engagement).toBeNull();
    // Goal sums are additive facts: present (0 is a valid measured zero
    // because the source contributed rows).
    expect(rows[0]?.ga4GoalConversions).toEqual({ current: 0, previous: 0 });
  });

  it("keeps goal conversions independent of engagement presence (spec 010)", () => {
    const rows = joinUrlEvidence({
      ga4: [
        {
          landingPage: "https://example.com/a",
          currentSessions: 10,
          previousSessions: 10,
          currentGoalConversions: 3,
          previousGoalConversions: 1,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ga4GoalConversions).toEqual({ current: 3, previous: 1 });
    expect(rows[0]?.ga4Engagement).toBeNull();
  });

  it("produces identical output for shuffled inputs (spec 010)", () => {
    const input = {
      hostContext: "example.com",
      gsc: [
        { url: "https://example.com/b", clicks: 2, impressions: 20 },
        { url: "https://example.com/a", clicks: 1, impressions: 10 },
      ],
      ga4: [
        {
          landingPage: "/a",
          currentSessions: 5,
          previousSessions: 6,
          currentEngagedSessions: 3,
          previousEngagedSessions: 4,
          currentGoalConversions: 1,
          previousGoalConversions: 2,
        },
        {
          landingPage: "/b",
          currentSessions: 7,
          previousSessions: 8,
          currentEngagedSessions: 5,
          previousEngagedSessions: 6,
        },
      ],
      rank: [
        { url: "https://example.com/a", worsened: false },
        { url: "https://example.com/b", worsened: true },
      ],
    };
    const forward = joinUrlEvidence(input);
    const shuffled = joinUrlEvidence({
      hostContext: "example.com",
      gsc: [...input.gsc].toReversed(),
      ga4: [...input.ga4].toReversed(),
      rank: [...input.rank].toReversed(),
    });
    expect(shuffled).toEqual(forward);
  });

  it("collapses 006 must-join pairs and keeps must-not-join pairs apart (spec 010)", () => {
    const rows = joinUrlEvidence({
      hostContext: "example.com",
      gsc: [
        { url: "http://www.example.com/page", clicks: 1, impressions: 10 },
        { url: "https://example.com/page/", clicks: 2, impressions: 20 },
      ],
      ga4: [
        {
          landingPage: "/page",
          currentSessions: 3,
          previousSessions: 4,
          currentEngagedSessions: 2,
          previousEngagedSessions: 3,
        },
      ],
      rank: [{ url: "https://example.com/page?a=1", worsened: false }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gscClicks).toBe(3);
    expect(rows[0]?.ga4Sessions).toEqual({ current: 3, previous: 4 });

    const split = joinUrlEvidence({
      hostContext: "example.com",
      gsc: [
        { url: "https://blog.example.com/page", clicks: 1, impressions: 10 },
        { url: "https://example.com/page", clicks: 2, impressions: 20 },
      ],
    });
    // Subdomain rows never join the bare-host row.
    expect(split).toHaveLength(2);
  });
});
