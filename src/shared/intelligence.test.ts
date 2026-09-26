import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFindingKey,
  buildInsightKey,
  buildOpportunityLogicalKey,
  canonicalCannibalizationPair,
  canonicalJson,
  canonicalKeyword,
  canonicalRankKey,
  canonicalTechnicalKey,
  canonicalUrl,
  compareOpportunities,
  confidenceBandOf,
  findingSchema,
  impactBandOf,
  insightSchema,
  opportunitySchema,
  priorityMatrix,
  renormalizedScore,
  stableHash,
} from "./intelligence";
import { normalizeGa4LandingPage } from "./ga4";

describe("intelligence structural locks", () => {
  it("has no rankScore key anywhere in the contracts module", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/shared/intelligence.ts"),
      "utf8",
    );
    expect(content.includes("rankScore")).toBe(false);
  });

  it("has no causedBy field anywhere in the contracts module", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/shared/intelligence.ts"),
      "utf8",
    );
    expect(content.includes("causedBy")).toBe(false);
  });

  it("requires explanationFact on findings (fact/recommendation split)", () => {
    const withoutFact = {
      findingKey: "c".repeat(64),
      detectorKey: "low_ctr_query",
      detectorVersion: 1,
      projectId: "p1",
      entityKey: "q",
      entity: { query: "q" },
      evidence: {
        metrics: {},
        sources: ["gsc"],
        thresholdsApplied: {},
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {},
      },
      detectedAt: "2026-01-01T00:00:00.000Z",
      confidenceScore: 80,
      coverageFlags: {},
    };
    expect(findingSchema.safeParse(withoutFact).success).toBe(false);
  });

  it("rejects findings with non-observational evidence", () => {
    const base = {
      findingKey: "a".repeat(64),
      detectorKey: "low_ctr_query",
      detectorVersion: 1,
      projectId: "p1",
      entityKey: "q",
      entity: {},
      explanationFact: "f",
      evidence: {
        metrics: {},
        sources: ["gsc"],
        thresholdsApplied: {},
        correlations: [],
        evidenceType: "provider_confirmed",
        partialData: [],
        confidenceInputs: {},
      },
      detectedAt: "2026-01-01T00:00:00.000Z",
      confidenceScore: 80,
      coverageFlags: {},
    };
    expect(findingSchema.safeParse(base).success).toBe(false);
  });

  it("rejects insights with a lifecycle status field", () => {
    const parsed = insightSchema.safeParse({
      insightKey: "c:g",
      composerKey: "c",
      severity: "high",
      title: "t",
      explanationFact: "f",
      evidenceSummary: "e",
      entityRefs: [],
      sources: ["gsc"],
      findingKeys: [],
      opportunityIds: [],
      contentVersion: 1,
      contentHash: "h",
      scanId: "s",
      detectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      status: "open",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a minimal valid finding and opportunity", () => {
    const finding = {
      findingKey: "b".repeat(64),
      detectorKey: "low_ctr_query",
      detectorVersion: 1,
      projectId: "p1",
      entityKey: "q",
      entity: { query: "q" },
      explanationFact: "Query q has low CTR.",
      evidence: {
        metrics: { clicks: 10 },
        sources: ["gsc"],
        thresholdsApplied: { minImpressions: 100 },
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: { coverage: 1 },
      },
      detectedAt: "2026-01-01T00:00:00.000Z",
      confidenceScore: 80,
      coverageFlags: { truncated: false },
    };
    expect(findingSchema.safeParse(finding).success).toBe(true);
    const opportunity = {
      logicalKey: "low_ctr_query:q",
      occurrenceNumber: 1,
      type: "ctr",
      detectorKey: "low_ctr_query",
      detectorVersion: 1,
      scoreVersion: 1,
      status: "open",
      impactScore: 70,
      confidenceScore: 80,
      priority: "High",
      title: "t",
      explanationFact: "f",
      recommendation: "r",
      evidence: { metrics: {}, sources: ["gsc"] },
      sources: ["gsc"],
      consecutiveMisses: 0,
      stale: false,
      firstDetectedAt: "2026-01-01T00:00:00.000Z",
      lastDetectedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(opportunitySchema.safeParse(opportunity).success).toBe(true);
  });
});

describe("canonical keys", () => {
  it("lowercases keywords and agrees on page identity with GA4 sync", () => {
    expect(canonicalKeyword("  SEO Audit ")).toBe("seo audit");
    expect(canonicalUrl("/pricing?utm_source=x#frag")).toBe(
      normalizeGa4LandingPage("/pricing?utm_source=x#frag"),
    );
    expect(canonicalUrl("/pricing?utm_source=x#frag")).toBe("/pricing");
  });

  it("builds technical, rank, and cannibalization keys deterministically", () => {
    expect(canonicalTechnicalKey("Missing_Title", "/Product")).toBe(
      "technical:missing_title:/Product",
    );
    expect(canonicalRankKey("SEO", "Desktop", "US")).toBe(
      "rank:seo:desktop:us",
    );
    expect(canonicalCannibalizationPair("/b", "/a", "SEO")).toBe(
      canonicalCannibalizationPair("/a", "/b", "seo"),
    );
  });

  it("builds stable finding keys that change with any identity part", async () => {
    const base = {
      projectId: "p1",
      detectorKey: "d",
      detectorVersion: 1,
      entityKey: "e",
      periodFrom: "2026-01-01",
      periodTo: "2026-01-07",
    };
    const first = await buildFindingKey(base);
    expect(first).toHaveLength(64);
    expect(await buildFindingKey(base)).toBe(first);
    expect(await buildFindingKey({ ...base, periodTo: "2026-01-08" })).not.toBe(
      first,
    );
    expect(buildOpportunityLogicalKey("d", "e")).toBe("d:e");
    expect(buildInsightKey("c", "g")).toBe("c:g");
  });

  it("hashes canonically regardless of key order", async () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(await stableHash({ b: 1, a: 2 })).toBe(
      await stableHash({ a: 2, b: 1 }),
    );
    expect((await stableHash({ a: 1 })).length).toBe(64);
  });
});

describe("scoring helpers", () => {
  it("bands impact and confidence per §2", () => {
    expect(impactBandOf(80)).toBe("Critical");
    expect(impactBandOf(60)).toBe("High");
    expect(impactBandOf(40)).toBe("Medium");
    expect(impactBandOf(39)).toBe("Low");
    expect(confidenceBandOf(70)).toBe("High");
    expect(confidenceBandOf(40)).toBe("Medium");
    expect(confidenceBandOf(39)).toBe("Low");
  });

  it("maps every matrix cell per §2", () => {
    expect(priorityMatrix("Critical", "High")).toBe("Critical");
    expect(priorityMatrix("Critical", "Medium")).toBe("High");
    expect(priorityMatrix("High", "High")).toBe("High");
    expect(priorityMatrix("High", "Medium")).toBe("High");
    expect(priorityMatrix("Critical", "Low")).toBe("Medium");
    expect(priorityMatrix("High", "Low")).toBe("Medium");
    expect(priorityMatrix("Medium", "High")).toBe("Medium");
    expect(priorityMatrix("Medium", "Medium")).toBe("Medium");
    expect(priorityMatrix("Medium", "Low")).toBe("Low");
    expect(priorityMatrix("Low", "Low")).toBe("Low");
  });

  it("sorts canonically: priority, impact, confidence, recency", () => {
    const rows = [
      {
        priority: "High" as const,
        impactScore: 70,
        confidenceScore: 80,
        lastDetectedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        priority: "Critical" as const,
        impactScore: 10,
        confidenceScore: 10,
        lastDetectedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        priority: "High" as const,
        impactScore: 90,
        confidenceScore: 10,
        lastDetectedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect([...rows].toSorted(compareOpportunities)[0]?.priority).toBe(
      "Critical",
    );
    expect(
      [...rows]
        .filter((row) => row.priority === "High")
        .toSorted(compareOpportunities)[0]?.impactScore,
    ).toBe(90);
  });

  it("renormalizes missing factors instead of scoring zero", () => {
    // Worked example from §10: weights 30/25/20/15/10 with GA4 absent
    // (divisor 90) matches GA4-present given identical available evidence.
    const full = [
      { weight: 30, value: 0.5 },
      { weight: 25, value: 0.5 },
      { weight: 20, value: 0.5 },
      { weight: 15, value: 0.5 },
      { weight: 10, value: 0.5 },
    ];
    const missing = [
      { weight: 30, value: 0.5 },
      { weight: 25, value: 0.5 },
      { weight: 20, value: 0.5 },
      { weight: 15, value: 0.5 },
      { weight: 10, value: null },
    ];
    expect(renormalizedScore(full)).toBe(50);
    expect(renormalizedScore(missing)).toBe(50);
    expect(renormalizedScore([])).toBeNull();
    expect(renormalizedScore([{ weight: 10, value: null }])).toBeNull();
  });
});
