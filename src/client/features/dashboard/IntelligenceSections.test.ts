/** Dashboard intelligence sections rendering (spec 011, US3 — T021).
 *
 *  - metrics render only in data states (ready/partial/stale)
 *  - not_connected renders the connect CTA, never numbers
 *  - no_data and empty render distinct messages (never zeroed numbers)
 *  - failure renders retry affordance, never metric values
 *  - goal-named conversion rows render by stored name
 *  - renders full metric suite: CTR, avg position, organic sessions, engagement rate, top 100,
 *    transactions, top issues breakdown, new/lost backlinks, fact vs recommendation */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntelligenceSections } from "./IntelligenceSections";
import type { DashboardIntelligenceSections } from "@/server/features/dashboard/services/DashboardService";
import type { CoverageNote } from "@/shared/intelligence";

function coverage(source: CoverageNote["source"]): CoverageNote {
  return { source, freshness: null, completeness: "full", detail: null };
}

function delta(current: number, previous: number | null = null) {
  return {
    current,
    previous,
    change: previous === null ? null : current - previous,
    changePct:
      previous === null || previous === 0
        ? null
        : ((current - previous) / previous) * 100,
  };
}

function readySections(): DashboardIntelligenceSections {
  return {
    seoPerformance: {
      state: "ready",
      coverage: coverage("gsc"),
      metrics: {
        clicks: delta(100, 80),
        impressions: delta(1000, 900),
        ctr: delta(0.1, 0.09),
        avgPosition: delta(5, 6),
      },
    },
    searchVisibility: {
      state: "ready",
      coverage: coverage("rank"),
      metrics: {
        top3: delta(1, null),
        top10: delta(1, null),
        top100: delta(2, null),
        improved: 3,
        declined: 1,
        trackedKeywords: 10,
      },
    },
    trafficEngagement: {
      state: "ready",
      coverage: coverage("ga4"),
      metrics: {
        sessions: delta(50, 40),
        organicSessions: delta(30, 20),
        engagedSessions: delta(30, 20),
        engagementRate: delta(0.6, 0.5),
      },
    },
    conversions: {
      state: "ready",
      coverage: coverage("ga4"),
      metrics: {
        keyEvents: [{ name: "Newsletter signup", count: delta(7, 5) }],
        transactions: delta(4, 2),
      },
    },
    opportunities: {
      state: "ready",
      coverage: coverage("opportunities"),
      metrics: { critical: 1, high: 2, medium: 3, openTotal: 6 },
    },
    technicalHealth: {
      state: "ready",
      coverage: coverage("audit"),
      metrics: {
        status: "completed",
        pagesCrawled: 42,
        startedAt: "2026-09-27T00:00:00.000Z",
        topIssues: [
          {
            issueType: "broken_internal_links",
            severity: "critical",
            count: 3,
          },
          {
            issueType: "missing_meta_descriptions",
            severity: "warning",
            count: 8,
          },
        ],
        totalIssueTypes: 3,
        lastAuditAt: "2026-09-27T00:00:00.000Z",
      },
    },
    backlinks: {
      state: "ready",
      coverage: coverage("backlinks"),
      metrics: {
        backlinks: 1000,
        referringDomains: 500,
        newBacklinks: 10,
        lostBacklinks: 3,
        newReferringDomains: 4,
        lostReferringDomains: 1,
        capturedAt: "2026-09-27T00:00:00.000Z",
      },
    },
    recentChanges: {
      state: "ready",
      coverage: coverage("insights"),
      metrics: {
        items: [
          {
            title: "Traffic dip",
            fact: "Clicks dropped 20% this week.",
            recommendation: "Check decayed pages.",
            sources: ["gsc"],
            detectedAt: "2026-09-27T00:00:00.000Z",
            severity: "high",
          },
        ],
        dismissedCount: 1,
      },
    },
  };
}

function render(sections: DashboardIntelligenceSections) {
  return renderToStaticMarkup(
    React.createElement(IntelligenceSections, {
      projectId: "project_1",
      sections,
      onRetry: () => {},
    }),
  );
}

describe("IntelligenceSections (spec 011, T021 & Dashboard Intelligence UI)", () => {
  it("renders stored metrics in ready state across all eight sections", () => {
    const html = render(readySections());
    // SEO performance: clicks, impressions, ctr, avgPosition
    expect(html).toContain("Clicks");
    expect(html).toContain("Impressions");
    expect(html).toContain("CTR");
    expect(html).toContain("Avg position");
    expect(html).toContain("10.0%"); // 0.1 * 100

    // Search visibility: top 3, top 10, top 100, ranking movements
    expect(html).toContain("Top 3");
    expect(html).toContain("Top 10");
    expect(html).toContain("Top 100");
    expect(html).toContain("3 improved");
    expect(html).toContain("1 declined");

    // Traffic & engagement: sessions, organic sessions, engaged sessions, engagement rate
    expect(html).toContain("Sessions");
    expect(html).toContain("Organic sessions");
    expect(html).toContain("Engaged sessions");
    expect(html).toContain("Engagement rate");
    expect(html).toContain("60.0%"); // 0.6 * 100

    // Conversions: transactions & key events
    expect(html).toContain("Transactions");
    expect(html).toContain("Newsletter signup");

    // Opportunities: open, critical, high, medium
    expect(html).toContain("Open Opportunities");
    expect(html).toContain(">6<");

    // Technical health: crawled pages & top issues breakdown
    expect(html).toContain("42");
    expect(html).toContain("broken_internal_links");
    expect(html).toContain("3 pages");
    expect(html).toContain("+ 1 more issue");

    // Backlinks: totals and new/lost links
    expect(html).toContain("1,000");
    expect(html).toContain("500");
    expect(html).toContain("▲ 10");
    expect(html).toContain("▼ 3");

    // Recent changes: fact vs recommendation, sources, severity
    expect(html).toContain("Traffic dip");
    expect(html).toContain("Clicks dropped 20% this week.");
    expect(html).toContain("Recommendation:");
    expect(html).toContain("Check decayed pages.");
    expect(html).toContain("GSC");
    expect(html).toContain("High");
  });

  it("renders healthy message when technical health audit has no issues", () => {
    const sections = readySections();
    sections.technicalHealth.metrics = {
      status: "completed",
      pagesCrawled: 50,
      startedAt: "2026-09-27T00:00:00.000Z",
      topIssues: [],
      totalIssueTypes: 0,
      lastAuditAt: "2026-09-27T00:00:00.000Z",
    };
    const html = render(sections);
    expect(html).toContain("No issues found — your site looks healthy.");
  });

  it("does not render healthy banner when audit crawled 0 pages", () => {
    const sections = readySections();
    sections.technicalHealth.metrics = {
      status: "completed",
      pagesCrawled: 0,
      startedAt: "2026-09-27T00:00:00.000Z",
      topIssues: [],
      totalIssueTypes: 0,
      lastAuditAt: "2026-09-27T00:00:00.000Z",
    };
    const html = render(sections);
    expect(html).not.toContain("No issues found — your site looks healthy.");
  });

  it("keeps metrics visible in partial and stale states with a footnote", () => {
    const sections = readySections();
    sections.opportunities.state = "partial";
    sections.backlinks.state = "stale";
    const html = render(sections);
    expect(html).toContain("1,000");
    expect(html).toMatch(/partial|outdated/i);
  });

  it("renders not_connected with a connect CTA and no numbers", () => {
    const sections = readySections();
    sections.trafficEngagement = {
      state: "not_connected",
      coverage: { ...coverage("ga4"), completeness: "none" as const },
      metrics: null,
    };
    const html = render(sections);
    expect(html).toContain("Connect Google Analytics");
    expect(html).toContain("Open Analytics");
    // The disconnected section contributes no metric stats
    expect(html).not.toContain("Engaged sessions");
  });

  it("renders no_data and empty with distinct messages, never zeros", () => {
    const sections = readySections();
    sections.backlinks = {
      state: "no_data",
      coverage: { ...coverage("backlinks"), completeness: "none" as const },
      metrics: null,
    };
    sections.opportunities = {
      state: "empty",
      coverage: coverage("opportunities"),
      metrics: { critical: 0, high: 0, medium: 0, openTotal: 0 },
    };
    const html = render(sections);
    expect(html).toContain("No backlink snapshot has been captured");
    expect(html).toContain("No open opportunities right now");
    // Empty metrics must not leak zeroed stats into the section body.
    expect(html).not.toContain(">0<");
  });

  it("renders failure with retry and no metric values", () => {
    const sections = readySections();
    sections.seoPerformance = {
      state: "api_failed",
      coverage: {
        ...coverage("gsc"),
        completeness: "none" as const,
        detail: "Section read failed",
      },
      metrics: null,
    };
    const html = render(sections);
    expect(html).toContain("Retry");
    expect(html).toContain("failed to load");
    expect(html).not.toContain(">100<");
  });
});
