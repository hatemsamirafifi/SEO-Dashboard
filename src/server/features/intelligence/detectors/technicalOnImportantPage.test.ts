import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("pure detector tests must not touch the database");
      },
    },
  ),
}));

import {
  detectTechnical,
  isTechnicalInput,
  type TechnicalInput,
} from "./technicalOnImportantPage";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: { minWindowDays: 28, topN: 50, severity: "critical" },
    thresholdVersion: 2,
  };
}

function input(overrides: Partial<TechnicalInput> = {}): TechnicalInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    auditId: "audit-1",
    issues: [
      {
        issueType: "missing_title",
        pageUrl: "https://example.com/pricing",
        pageClicks: 1240,
        pageImpressions: 30000,
        ga4Vote: false,
      },
    ],
    ga4Available: false,
    thresholds: { minWindowDays: 28, topN: 50, severity: "critical" },
    ...overrides,
  };
}

describe("technical_on_important_page", () => {
  it("emits critical issues on important pages with discriminator identity", () => {
    const findings = detectTechnical(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe(
      "technical:missing_title:https://example.com/pricing",
    );
    expect(findings[0]?.evidence.sources).toEqual(["audit", "gsc"]);
    expect(findings[0]?.evidence.partialData).toContain(
      "ga4_landing_vote_pending",
    );
    expect(findings[0]?.explanationFact).toContain("1,240 clicks");
  });

  it("lifts confidence on a GA4 second vote", () => {
    const findings = detectTechnical(
      ctx(),
      input({
        issues: [
          {
            issueType: "missing_title",
            pageUrl: "https://example.com/pricing",
            pageClicks: 1240,
            pageImpressions: 30000,
            ga4Vote: true,
          },
        ],
        ga4Available: true,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidenceScore).toBe(80);
    expect(findings[0]?.evidence.sources).toEqual(["audit", "gsc", "ga4"]);
    expect(findings[0]?.evidence.partialData).toEqual([]);
    expect(findings[0]?.explanationFact).toContain("top GA4 landing page");
  });

  it("stays silent when no important page carries a critical issue", () => {
    expect(detectTechnical(ctx(), input({ issues: [] }))).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isTechnicalInput(null)).toBe(false);
    expect(isTechnicalInput({ issues: [] })).toBe(false);
    expect(isTechnicalInput(input())).toBe(true);
  });
});
