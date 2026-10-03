/** Dashboard intelligence sections rendering (spec 011, US3 — T021).
 *
 *  TDD: FAILS until IntelligenceSections + SectionStateShell exist (T023).
 *  - metrics render only in data states (ready/partial/stale)
 *  - not_connected renders the connect CTA, never numbers
 *  - no_data and empty render distinct messages (never zeroed numbers)
 *  - failure renders retry affordance, never metric values
 *  - goal-named conversion rows render by stored name */
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
    changePct: null,
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
        improved: 1,
        declined: 1,
        trackedKeywords: 1,
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
      metrics: { critical: 1, high: 1, medium: 1, openTotal: 3 },
    },
    technicalHealth: {
      state: "ready",
      coverage: coverage("audit"),
      metrics: {
        status: "completed",
        pagesCrawled: 10,
        startedAt: new Date().toISOString(),
        topIssues: [],
        totalIssueTypes: 0,
        lastAuditAt: new Date().toISOString(),
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
        capturedAt: new Date().toISOString(),
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

describe("IntelligenceSections (spec 011, T021)", () => {
  it("renders stored metrics in ready state, including goal-named conversions", () => {
    const html = render(readySections());
    expect(html).toContain("Newsletter signup");
    expect(html).toContain("Traffic dip");
    expect(html).toContain("Clicks dropped 20% this week.");
    expect(html).toContain("Open Opportunities");
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
    // The disconnected section contributes no metric stats (other sections
    // still render theirs — scope the absence to this section's labels).
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
