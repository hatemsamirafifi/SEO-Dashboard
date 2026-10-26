import { describe, expect, it, vi } from "vitest";

const { domainMock, getRunsMock, getCitationsMock } = vi.hoisted(() => ({
  domainMock: vi.fn(async (): Promise<string | null> => null),
  getRunsMock: vi.fn(
    // oxlint-disable-next-line typescript/no-unused-vars -- fixture mock; params typed so call args type-check
    async (
      _projectId: string,
      _since: string,
      _limit?: number,
    ): Promise<unknown[]> => [],
  ),
  getCitationsMock: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@/server/lib/seo-data/competitor-snapshot-repository", () => ({
  getProjectDomain: domainMock,
}));
vi.mock("@/server/features/ai-search/repositories/AiSearchObservationRepository", () => ({
  AiSearchObservationRepository: {
    recordRun: vi.fn(),
    getRunsForProject: getRunsMock,
    getCitationsForRuns: getCitationsMock,
  },
}));

import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import type { DetectorContext } from "./types";
import type { StoredAiSearchCitation, StoredAiSearchRun } from "@/server/features/ai-search/repositories/AiSearchObservationRepository";
import {
  aiCitationGapDetector,
  detectAiCitationGap,
  fetchAiCitationGapInput,
  type AiCitationGapInput,
  type AiCitationGapRunRow,
} from "./aiCitationGap";

function ctx(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    periodFrom: "",
    periodTo: "",
    thresholds: defaultThresholdsFor("ai_citation_gap"),
    thresholdVersion: 7,
    ...overrides,
  };
}

function run(
  runId: string,
  model: string,
  citations: Array<[domain: string, position: number]>,
  observedAt: string,
): AiCitationGapRunRow {
  return {
    runId,
    model,
    observedAt,
    citations: citations.map(([domain, position]) => ({
      url: `https://${domain}/p${position}`,
      domain,
      title: null,
      position,
    })),
  };
}

function input(overrides: Partial<AiCitationGapInput> = {}): AiCitationGapInput {
  return {
    periodFrom: "2026-10-19T00:00:00.000Z",
    periodTo: "2026-10-24T00:00:00.000Z",
    observationCount: 6,
    projectDomain: "our-domain.com",
    runs: [],
    thresholds: {
      freshnessDays: 30,
      maxRunsRead: 200,
      smallSampleFloor: 5,
      frequentlyCitedMinRuns: 3,
    },
    ...overrides,
  };
}

/** Six observed answers: two cite only others, one is ours-only, one mixes,
 *  one has no citations, and competitor1.com appears in three runs. */
function seededRuns(): AiCitationGapRunRow[] {
  return [
    run("run-a", "chat_gpt", [["competitor1.com", 1], ["competitor2.com", 2]], "2026-10-24T10:00:00.000Z"),
    run("run-b", "gemini", [["our-domain.com", 1]], "2026-10-20T10:00:00.000Z"),
    run("run-c", "claude", [["competitor1.com", 1]], "2026-10-23T10:00:00.000Z"),
    run("run-d", "perplexity", [["competitor1.com", 3]], "2026-10-22T10:00:00.000Z"),
    run("run-e", "chat_gpt", [], "2026-10-21T10:00:00.000Z"),
    run("run-f", "gemini", [["our-domain.com", 1], ["competitor3.com", 2]], "2026-10-19T10:00:00.000Z"),
  ];
}

function storedRun(id: string, observedAt: string): StoredAiSearchRun {
  return {
    id,
    projectId: "project-1",
    provider: "dataforseo",
    model: "chat_gpt",
    modelName: "gpt-5",
    promptHash: "hash",
    promptLength: 30,
    webSearch: true,
    countryCode: null,
    outputTokens: 100,
    fanOutCount: 0,
    citationCount: 1,
    eventKey: "event",
    observedAt,
  };
}

function citation(
  runId: string,
  domain: string,
  position: number,
): StoredAiSearchCitation {
  return {
    runId,
    url: `https://${domain}/p${position}`,
    domain,
    title: null,
    position,
    citedAt: "2026-10-24T10:00:00.000Z",
  };
}

describe("detectAiCitationGap", () => {
  it("emits the three finding families with their observed counts", () => {
    const findings = detectAiCitationGap(ctx(), input({ runs: seededRuns() }));

    const byFamily = (family: string) =>
      findings.filter((finding) => finding.entity.family === family);
    expect(byFamily("cited_without_us")).toHaveLength(3);
    expect(byFamily("frequent_third_party")).toHaveLength(1);
    expect(byFamily("no_cited_sources")).toHaveLength(1);

    const cited = byFamily("cited_without_us");
    expect(cited.map((finding) => finding.entity.runId)).toEqual([
      "run-a",
      "run-c",
      "run-d",
    ]);
    const first = cited[0];
    expect(first?.entityKey).toBe("cited_without_us:run-a");
    expect(first?.evidence.metrics).toMatchObject({
      observationCount: 6,
      smallSample: false,
      citationCount: 2,
      distinctDomainCount: 2,
      firstPartyCited: false,
      firstPosition: 1,
    });
    expect(first?.evidence.sources).toEqual(["ai_search"]);
    expect(first?.evidence.sourceRefs?.aiSearchRunIds).toEqual(["run-a"]);
    expect(first?.evidence.thresholdsApplied).toMatchObject({
      smallSampleFloor: 5,
    });
    expect(first?.evidence.partialData).toEqual([]);
    expect(first?.confidenceScore).toBe(65);
    expect(first?.explanationFact).toContain("competitor1.com");
    expect(first?.explanationFact).toContain("our-domain.com");
    expect(first?.explanationFact).toContain("chat_gpt");

    const frequent = byFamily("frequent_third_party");
    expect(frequent[0]?.entityKey).toBe("frequent_third_party:competitor1.com");
    expect(frequent[0]?.evidence.metrics).toMatchObject({
      observationCount: 6,
      runsCitingDomain: 3,
      runSharePct: 50,
    });
    expect(frequent[0]?.evidence.sourceRefs?.aiSearchRunIds).toEqual([
      "run-a",
      "run-c",
      "run-d",
    ]);
    expect(frequent[0]?.confidenceScore).toBe(70);

    const none = byFamily("no_cited_sources");
    expect(none[0]?.entityKey).toBe("no_cited_sources:run-e");
    expect(none[0]?.evidence.metrics).toMatchObject({
      observationCount: 6,
      citationCount: 0,
    });
    expect(none[0]?.confidenceScore).toBe(50);

    // A run whose only citation is our own page, and a mixed run where we
    // were cited, are never "cited without us" findings (spec edge cases).
    expect(
      findings.some((finding) => finding.entity.runId === "run-b"),
    ).toBe(false);
    expect(
      findings.some((finding) => finding.entity.runId === "run-f"),
    ).toBe(false);
    // Domains below the frequently-cited floor never emit.
    expect(
      findings.some(
        (finding) => finding.entity.domain === "competitor2.com",
      ),
    ).toBe(false);
  });

  it("labels every finding small-sample below the floor and lowers confidence", () => {
    const small = seededRuns().filter((row) =>
      ["run-a", "run-b", "run-c", "run-e"].includes(row.runId),
    );
    const findings = detectAiCitationGap(
      ctx(),
      input({ runs: small, observationCount: small.length }),
    );

    expect(findings.length).toBe(3);
    for (const finding of findings) {
      expect(finding.evidence.metrics.smallSample).toBe(true);
      expect(finding.evidence.partialData).toEqual([
        "small_sample:4 observations (floor 5)",
      ]);
      expect(finding.confidenceScore).toBe(45);
      expect(finding.coverageFlags).toMatchObject({
        aiSearchObservations: 4,
        smallSample: true,
      });
    }
    // Two observations of competitor1.com stay below the run floor.
    expect(
      findings.some(
        (finding) => finding.entity.family === "frequent_third_party",
      ),
    ).toBe(false);
  });

  it("orders findings deterministically and counts a domain once per run", () => {
    const findings = detectAiCitationGap(
      ctx(),
      input({
        runs: [
          run("run-x", "chat_gpt", [["competitor1.com", 1], ["competitor1.com", 2]], "2026-10-24T10:00:00.000Z"),
          run("run-y", "claude", [["competitor1.com", 1], ["competitor2.com", 2]], "2026-10-23T10:00:00.000Z"),
          run("run-z", "gemini", [["competitor1.com", 1]], "2026-10-22T10:00:00.000Z"),
          run("run-w", "perplexity", [], "2026-10-21T10:00:00.000Z"),
        ],
      }),
    );

    expect(findings.map((finding) => finding.entityKey)).toEqual([
      "cited_without_us:run-x",
      "cited_without_us:run-y",
      "cited_without_us:run-z",
      "frequent_third_party:competitor1.com",
      "no_cited_sources:run-w",
    ]);

    const frequent = findings.find(
      (finding) => finding.entity.family === "frequent_third_party",
    );
    // Two same-domain citations inside run-x still count that run once.
    expect(frequent?.evidence.metrics.runsCitingDomain).toBe(3);
  });

  it("rejects mistyped input loudly", () => {
    expect(() => aiCitationGapDetector.detect(ctx(), {})).toThrow(
      "ai_citation_gap: mistyped input",
    );
  });
});

describe("fetchAiCitationGapInput", () => {
  it("skips loudly when the project has no domain", async () => {
    domainMock.mockResolvedValue(null);
    await expect(fetchAiCitationGapInput("project-1", ctx())).rejects.toThrow(
      "ai_citation_gap: project has no domain",
    );
  });

  it("skips loudly when no observations are recorded", async () => {
    domainMock.mockResolvedValue("our-domain.com");
    getRunsMock.mockResolvedValue([]);
    await expect(fetchAiCitationGapInput("project-1", ctx())).rejects.toThrow(
      "ai_citation_gap: no recorded AI search observations",
    );
  });

  it("assembles the normalized analysis input from stored rows", async () => {
    domainMock.mockResolvedValue("https://www.Our-Domain.com/x");
    getRunsMock.mockResolvedValue([
      storedRun("run-older", "2026-10-22T10:00:00.000Z"),
      storedRun("run-newer", "2026-10-24T10:00:00.000Z"),
    ]);
    getCitationsMock.mockResolvedValue([
      citation("run-newer", "our-domain.com", 1),
      citation("run-newer", "www.Competitor1.com", 2),
      citation("run-older", "competitor2.com", 1),
    ]);

    const assembled = await fetchAiCitationGapInput("project-1", ctx());

    expect(assembled.projectDomain).toBe("our-domain.com");
    expect(assembled.observationCount).toBe(2);
    expect(assembled.periodFrom).toBe("2026-10-22T10:00:00.000Z");
    expect(assembled.periodTo).toBe("2026-10-24T10:00:00.000Z");
    expect(assembled.thresholds).toEqual({
      freshnessDays: 30,
      maxRunsRead: 200,
      smallSampleFloor: 5,
      frequentlyCitedMinRuns: 3,
    });
    // Newest run first; citation domains fold to their canonical identity.
    expect(assembled.runs.map((row) => row.runId)).toEqual([
      "run-newer",
      "run-older",
    ]);
    expect(assembled.runs[0]?.citations.map((c) => c.domain)).toEqual([
      "our-domain.com",
      "competitor1.com",
    ]);
    // The freshness window and read bound come from the injected thresholds.
    const [projectId, since, limit] = getRunsMock.mock.calls[0];
    expect(projectId).toBe("project-1");
    expect(limit).toBe(200);
    expect(Date.parse(since)).toBeGreaterThan(
      Date.now() - 31 * 86_400_000,
    );
  });
});

describe("aiCitationGapDetector contract", () => {
  it("registers with the ai_search source and lets small samples emit", () => {
    expect(aiCitationGapDetector.detectorKey).toBe("ai_citation_gap");
    expect(aiCitationGapDetector.version).toBe(1);
    expect(aiCitationGapDetector.requiredSources).toEqual(["ai_search"]);
    // SC-004: labelled small-sample findings still emit (floor confidence 45).
    expect(aiCitationGapDetector.minConfidenceToEmit).toBeLessThanOrEqual(45);
    expect(aiCitationGapDetector.coverage.length).toBeGreaterThan(0);
  });
});