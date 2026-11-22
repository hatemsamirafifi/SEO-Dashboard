import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  SeoAnalysisResultSchema,
} from "@/shared/samSeoAnalyst";
import {
  buildPrioritizedActionPlan,
  generateRecommendationFingerprint,
} from "../analyst/seoRecommendations";
import { runSeoAnalysis } from "../analyst/seoAnalyzer";
import type { CollectedSeoEvidence } from "../analyst/seoEvidenceTypes";
import {
  SeoActionService,
  InvalidStatusTransitionError,
} from "./SeoActionService";
import { SeoActionRepository } from "./SeoActionRepository";
import {
  SeoActionVerificationEngine,
  evaluatePositionOutcome,
  isSufficientVerificationOutcome,
  parseBaselinePosition,
} from "./seoActionVerification";
import { buildSamActionTools } from "../samActionTools";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { getVerificationDisplayState } from "@/client/features/sam/actions/SamActionCard";

function makeBaseEvidence(
  overrides: Partial<CollectedSeoEvidence["details"]> = {},
): CollectedSeoEvidence {
  return {
    projectId: "proj-sports",
    domain: "sports-ms.com",
    collectedAt: "2026-11-21T02:00:00Z",
    focus: "action_plan",
    thresholds: DEFAULT_OPPORTUNITY_THRESHOLDS,
    sourceAvailability: [
      {
        source: "search_console",
        status: "available",
        provider: "google",
        freshnessLabel: "Synced today",
        recordCount: 5,
        limitations: [],
      },
      {
        source: "rank_tracking",
        status: "available",
        provider: "mixed",
        freshnessLabel: "2 days old",
        recordCount: 10,
        limitations: [
          "Rank observations originate from multiple providers: dataforseo, seranking.",
        ],
      },
    ],
    observations: [],
    measuredOverview: {
      searchConsole: {
        connected: true,
        coverageRange: { from: "2026-10-01", to: "2026-11-20" },
        totals: { clicks: 120, impressions: 5400, ctr: 0.022, position: 14.5 },
      },
      savedKeywordsCount: 0,
    },
    details: {
      rankTrackingRows: [],
      gscStrikingQueries: [],
      gscTopQueries: [],
      gscTopPages: [],
      auditIssues: [],
      auditPages: [],
      savedKeywords: [],
      competitorSnapshots: [],
      ...overrides,
    },
    limitations: [],
    missingInformation: [],
  };
}

describe("SAM SEO Analyst Phase 2: Evidence Quality Gates (Task 1)", () => {
  it("classifies anomalous / e-commerce spam query with low impressions as Low priority and non-destructive", () => {
    const evidence = makeBaseEvidence({
      gscStrikingQueries: [
        {
          query: "lanvin shop tops?c=123",
          page: "https://sports-ms.com/?c=123",
          clicks: 0,
          impressions: 1, // Single anomalous impression
          position: 12.0,
        },
      ],
    });

    const findings = runSeoAnalysis(evidence);
    const result = buildPrioritizedActionPlan(evidence, findings);

    expect(result.recommendations.length).toBeGreaterThan(0);
    const spamRec = result.recommendations.find((r) =>
      r.targetKeywords.includes("lanvin shop tops?c=123"),
    );

    expect(spamRec).toBeDefined();
    // Quality Gate: MUST NEVER be Critical or High
    expect(spamRec!.priority).toBe("Low");
    expect(spamRec!.expectedImpact).toBe("Low");
    expect(spamRec!.confidence.level).toBe("Low");
    expect(spamRec!.evidenceQuality?.signalStrength).toBe(
      "suspicious_investigate",
    );
    expect(spamRec!.evidenceQuality?.sampleSize).toBe("sparse");
    expect(spamRec!.evidenceQuality?.isDestructiveActionRecommended).toBe(
      false,
    );

    // Recommended action MUST be investigative, NOT destructive
    expect(spamRec!.recommendedAction).toContain(
      "Investigate query and landing page",
    );
    expect(spamRec!.recommendedAction).not.toContain("noindex");
    expect(spamRec!.recommendedAction).not.toContain("robots.txt");
    expect(spamRec!.recommendedAction).not.toContain("delete");
  });

  it("assigns High priority and robust signal strength to high-impression striking queries", () => {
    const evidence = makeBaseEvidence({
      gscStrikingQueries: [
        {
          query: "تركيب عشب صناعي",
          page: "https://sports-ms.com/turf",
          clicks: 45,
          impressions: 1200,
          position: 5.2,
        },
      ],
    });

    const findings = runSeoAnalysis(evidence);
    const result = buildPrioritizedActionPlan(evidence, findings);

    const rec = result.recommendations.find((r) =>
      r.targetKeywords.includes("تركيب عشب صناعي"),
    );
    expect(rec).toBeDefined();
    expect(rec!.priority).toBe("High");
    expect(rec!.expectedImpact).toBe("High");
    expect(rec!.confidence.level).toBe("High");
    expect(rec!.evidenceQuality?.signalStrength).toBe("strong_signal");
    expect(rec!.evidenceQuality?.sampleSize).toBe("robust");
  });

  it("generates deterministic recommendation fingerprints across runs", () => {
    const fp1 = generateRecommendationFingerprint(
      "proj-sports",
      "keyword_opportunity",
      ["عشب صناعي"],
      ["https://sports-ms.com/turf"],
      "striking_position",
    );
    const fp2 = generateRecommendationFingerprint(
      "proj-sports",
      "keyword_opportunity",
      ["عشب صناعي"],
      ["https://sports-ms.com/turf"],
      "striking_position",
    );
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(32);

    // Case and whitespace insensitivity
    const fp3 = generateRecommendationFingerprint(
      "proj-sports",
      "keyword_opportunity",
      ["  عشب صناعي  "],
      ["HTTPS://SPORTS-MS.COM/TURF"],
      "STRIKING_POSITION",
    );
    expect(fp1).toBe(fp3);
  });
});

describe("SAM SEO Analyst Phase 2: Action Lifecycle Transitions (Task 4)", () => {
  it("allows valid lifecycle transitions", () => {
    expect(SeoActionService.isValidTransition("proposed", "accepted")).toBe(
      true,
    );
    expect(SeoActionService.isValidTransition("proposed", "dismissed")).toBe(
      true,
    );
    expect(SeoActionService.isValidTransition("accepted", "in_progress")).toBe(
      true,
    );
    expect(SeoActionService.isValidTransition("accepted", "blocked")).toBe(
      true,
    );
    expect(SeoActionService.isValidTransition("in_progress", "completed")).toBe(
      true,
    );
    expect(
      SeoActionService.isValidTransition("completed", "verification_pending"),
    ).toBe(true);
    expect(
      SeoActionService.isValidTransition("verification_pending", "verified"),
    ).toBe(true);
    expect(SeoActionService.isValidTransition("verified", "reopened")).toBe(
      true,
    );
    expect(SeoActionService.isValidTransition("reopened", "in_progress")).toBe(
      true,
    );
  });

  it("rejects unauthorized and invalid state jumps", () => {
    expect(SeoActionService.isValidTransition("proposed", "completed")).toBe(
      false,
    );
    expect(SeoActionService.isValidTransition("proposed", "verified")).toBe(
      false,
    );
    expect(SeoActionService.isValidTransition("dismissed", "completed")).toBe(
      false,
    );
    expect(SeoActionService.isValidTransition("verified", "in_progress")).toBe(
      false,
    );
  });
});

describe("SAM SEO Analyst Phase 2: Action Plan Integration with Recommendations (Task 7)", () => {
  it("annotates recommendations with existing action item metadata when matching fingerprint exists", () => {
    const evidence = makeBaseEvidence({
      gscStrikingQueries: [
        {
          query: "بناء ملاعب خماسية",
          page: "https://sports-ms.com/courts",
          clicks: 10,
          impressions: 400,
          position: 6.0,
        },
      ],
    });

    const findings = runSeoAnalysis(evidence);

    const expectedFp = generateRecommendationFingerprint(
      "proj-sports",
      "keyword_opportunity",
      ["بناء ملاعب خماسية"],
      ["https://sports-ms.com/courts"],
      "striking_position",
    );

    const existingItems = [
      {
        id: "item-existing-1",
        recommendationFingerprint: expectedFp,
        status: "in_progress" as const,
        actionPlanId: "plan-1",
        baselineValue: "Position 6.0",
        verificationOutcome: null,
      },
    ];

    const result = buildPrioritizedActionPlan(
      evidence,
      findings,
      existingItems,
    );
    const rec = result.recommendations.find(
      (r) => r.fingerprint === expectedFp,
    );

    expect(rec).toBeDefined();
    expect(rec!.existingActionItem).toBeDefined();
    expect(rec!.existingActionItem?.id).toBe("item-existing-1");
    expect(rec!.existingActionItem?.status).toBe("in_progress");
    expect(result.markdownFallback).toContain("[Status: IN_PROGRESS]");
  });

  it("validates full result envelope against SeoAnalysisResultSchema", () => {
    const evidence = makeBaseEvidence({
      gscStrikingQueries: [
        {
          query: "تجهيز ملاعب",
          page: "https://sports-ms.com",
          clicks: 5,
          impressions: 200,
          position: 8.5,
        },
      ],
    });
    const findings = runSeoAnalysis(evidence);
    const result = buildPrioritizedActionPlan(evidence, findings);

    const parsed = SeoAnalysisResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

describe("SAM SEO Analyst Phase 2: Progress Verification Engine (Task 5)", () => {
  it("evaluates ranking improvement when current position is better (lower) than baseline", () => {
    const res = evaluatePositionOutcome(4, 10);
    expect(res.outcome).toBe("implemented_improved");
    expect(res.notes).toContain("improved from position 10 to 4");
  });

  it("evaluates ranking unchanged when current position equals baseline", () => {
    const res = evaluatePositionOutcome(5, 5);
    expect(res.outcome).toBe("implemented_unchanged");
    expect(res.notes).toContain("remains unchanged at position 5");
  });

  it("evaluates ranking declined when current position is worse (higher) than baseline", () => {
    const res = evaluatePositionOutcome(15, 8);
    expect(res.outcome).toBe("implemented_declined");
    expect(res.notes).toContain("moved lower from position 8 to 15");
  });

  it("handles null or missing baseline as insufficient_data", () => {
    const res = evaluatePositionOutcome(6, null);
    expect(res.outcome).toBe("insufficient_data");
    expect(res.notes).toContain("initial baseline value was unparseable");
  });

  it("parses baseline position accurately without matching impression/click counts", () => {
    expect(parseBaselinePosition("Position 12 (was 8)")).toBe(12);
    expect(parseBaselinePosition("120 impressions, pos 14.5")).toBe(14.5);
    expect(parseBaselinePosition("15")).toBe(15);
    expect(parseBaselinePosition("Active error")).toBeNull();
    expect(parseBaselinePosition(null)).toBeNull();
  });
});

describe("SAM SEO Analyst Phase 2: Tenant Isolation & Security Boundaries (Task 5)", () => {
  it("rejects status transitions and notes when item belongs to another project or org", async () => {
    const spy = vi
      .spyOn(SeoActionRepository, "getItemById")
      .mockResolvedValue(null);

    await expect(
      SeoActionService.transitionStatus({
        itemId: "item-foreign",
        projectId: "proj-sports",
        organizationId: "org-a",
        targetStatus: "accepted",
        actor: "attacker",
      }),
    ).rejects.toThrow("Action item item-foreign not found");

    await expect(
      SeoActionService.addNote({
        itemId: "item-foreign",
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "attacker",
        notes: "hijack",
      }),
    ).rejects.toThrow("Action item item-foreign not found");

    await expect(
      SeoActionVerificationEngine.verifyItem({
        itemId: "item-foreign",
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "attacker",
      }),
    ).rejects.toThrow("Action item item-foreign not found");

    await expect(
      SeoActionVerificationEngine.evaluateItem({
        itemId: "item-foreign",
        projectId: "proj-sports",
        organizationId: "org-a",
      }),
    ).rejects.toThrow("Action item item-foreign not found");

    expect(InvalidStatusTransitionError).toBeDefined();
    spy.mockRestore();
  });

  it("rejects autonomous sam_agent or empty actors from mutating workflow status", async () => {
    await expect(
      SeoActionService.transitionStatus({
        itemId: "item-1",
        projectId: "proj-sports",
        organizationId: "org-a",
        targetStatus: "accepted",
        actor: "sam_agent",
      }),
    ).rejects.toThrow("Authorized user actor is required");

    await expect(
      SeoActionVerificationEngine.verifyItem({
        itemId: "item-1",
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "sam_agent",
      }),
    ).rejects.toThrow("Authorized user actor is required");

    await expect(
      SeoActionVerificationEngine.verifyItem({
        itemId: "item-1",
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "   ",
      }),
    ).rejects.toThrow("Authorized user actor is required");
  });

  it("keeps SAM action tools strictly read-only and never mutates status during verify_seo_action_progress", async () => {
    const tools = buildSamActionTools({
      projectId: "proj-sports",
      organizationId: "org-a",
      userId: "user-1",
    });

    // SAM must NOT expose silent save or status transition tools
    expect(Object.keys(tools).toSorted()).toEqual([
      "get_seo_action_items",
      "get_seo_action_plan",
      "list_seo_action_plans",
      "verify_seo_action_progress",
    ]);

    const itemStub = {
      id: "item-gsc-1",
      actionPlanId: "plan-1",
      organizationId: "org-a",
      projectId: "proj-sports",
      recommendationFingerprint: "fp-1",
      title: "Improve CTR for target query",
      description: null,
      category: "keyword_opportunity",
      priority: "High",
      effort: "Low",
      expectedImpact: "High",
      evidenceConfidence: "High (85%)",
      targetKeyword: "تركيب عشب صناعي",
      targetUrl: "https://sports-ms.com/turf",
      recommendedAction: "Refine title and meta description",
      validationMetric: "Average position & CTR",
      baselineValue: "Position 8.5",
      baselineObservationDate: "2026-11-20",
      dueDate: null,
      status: "completed",
      verificationOutcome: null,
      verificationNotes: null,
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-21T00:00:00Z",
      completedAt: "2026-11-21T00:00:00Z",
      verifiedAt: null,
    };

    const getItemSpy = vi
      .spyOn(SeoActionRepository, "getItemById")
      .mockResolvedValue(itemStub);
    const getEvidenceSpy = vi
      .spyOn(SeoActionRepository, "getEvidenceForItem")
      .mockResolvedValue([
        {
          id: "ev-1",
          actionItemId: "item-gsc-1",
          source: "get_search_console_performance",
          provider: "google",
          sourceRecordId: null,
          metricName: "position",
          metricValue: "8.5",
          observationDate: "2026-11-20",
          observationRange: null,
          targetDevice: null,
          targetCountry: null,
          targetUrl: null,
          metadata: null,
        },
      ]);
    const gscCoverageSpy = vi
      .spyOn(GscSearchPerformanceRepository, "getStoredCoverageRange")
      .mockResolvedValue({
        startDate: "2026-10-01",
        endDate: "2026-11-20",
        totalDays: 51,
      });
    const updateSpy = vi.spyOn(SeoActionRepository, "updateItem");
    const addEventSpy = vi.spyOn(SeoActionRepository, "addEvent");

    try {
      const evaluation = await SeoActionVerificationEngine.evaluateItem({
        itemId: "item-gsc-1",
        projectId: "proj-sports",
        organizationId: "org-a",
      });

      expect(evaluation.outcome).toBe("insufficient_data");
      expect(evaluation.evidenceSufficient).toBe(false);
      expect(evaluation.awaitingNewerData).toBe(true);
      expect(evaluation.recommendedStatus).toBe("verification_pending");
      expect(updateSpy).not.toHaveBeenCalled();
      expect(addEventSpy).not.toHaveBeenCalled();
    } finally {
      getItemSpy.mockRestore();
      getEvidenceSpy.mockRestore();
      gscCoverageSpy.mockRestore();
      updateSpy.mockRestore();
      addEventSpy.mockRestore();
    }
  });
});

describe("SAM SEO Analyst Phase 2: Verification Outcome Semantics (Operational Closure)", () => {
  const baseCompletedItem = {
    id: "item-verify-1",
    actionPlanId: "plan-1",
    organizationId: "org-a",
    projectId: "proj-sports",
    recommendationFingerprint: "fp-verify-1",
    title: "Optimize landing page for striking query",
    description: null,
    category: "keyword_opportunity",
    priority: "High",
    effort: "Medium",
    expectedImpact: "High",
    evidenceConfidence: "High (85%)",
    targetKeyword: "تركيب عشب صناعي",
    targetUrl: "https://sports-ms.com/turf",
    recommendedAction: "Update H1 and title",
    validationMetric: "Average position",
    baselineValue: "Position 9.0",
    baselineObservationDate: "2026-11-20",
    dueDate: null,
    status: "completed",
    verificationOutcome: null,
    verificationNotes: null,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    completedAt: "2026-11-21T00:00:00Z",
    verifiedAt: null,
  };

  it("keeps task in verification_pending (never verified) when GSC coverage has insufficient newer data", async () => {
    const getItemSpy = vi
      .spyOn(SeoActionRepository, "getItemById")
      .mockResolvedValue(baseCompletedItem);
    const getEvidenceSpy = vi
      .spyOn(SeoActionRepository, "getEvidenceForItem")
      .mockResolvedValue([
        {
          id: "ev-gsc-1",
          actionItemId: baseCompletedItem.id,
          source: "get_search_console_performance",
          provider: "google",
          sourceRecordId: null,
          metricName: "position",
          metricValue: "9.0",
          observationDate: "2026-11-20",
          observationRange: null,
          targetDevice: null,
          targetCountry: null,
          targetUrl: null,
          metadata: null,
        },
      ]);
    const gscCoverageSpy = vi
      .spyOn(GscSearchPerformanceRepository, "getStoredCoverageRange")
      .mockResolvedValue({
        startDate: "2026-10-01",
        endDate: "2026-11-20",
        totalDays: 51,
      });
    const updateSpy = vi
      .spyOn(SeoActionRepository, "updateItem")
      .mockImplementation(async (_id, _proj, _org, updates) => ({
        ...baseCompletedItem,
        ...updates,
      }));
    const addEventSpy = vi
      .spyOn(SeoActionRepository, "addEvent")
      .mockResolvedValue({
        id: "evt-1",
        actionItemId: baseCompletedItem.id,
        actor: "user-1",
        previousStatus: "completed",
        newStatus: "verification_pending",
        notes: "",
        metadata: null,
        createdAt: new Date().toISOString(),
      });

    try {
      const result = await SeoActionVerificationEngine.verifyItem({
        itemId: baseCompletedItem.id,
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "user-1",
      });

      expect(result.outcome).toBe("insufficient_data");
      expect(result.evidenceSufficient).toBe(false);
      expect(result.awaitingNewerData).toBe(true);
      expect(result.verificationAttempted).toBe(true);
      expect(result.status).toBe("verification_pending");
      expect(result.item.status).toBe("verification_pending");
      expect(result.item.verifiedAt).toBeNull();

      expect(updateSpy).toHaveBeenCalledWith(
        baseCompletedItem.id,
        "proj-sports",
        "org-a",
        expect.objectContaining({
          status: "verification_pending",
          verificationOutcome: "insufficient_data",
          verifiedAt: null,
        }),
      );
      expect(addEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionItemId: baseCompletedItem.id,
          actor: "user-1",
          previousStatus: "completed",
          newStatus: "verification_pending",
          metadata: expect.objectContaining({
            verificationAttempted: true,
            evidenceSufficient: false,
            awaitingNewerData: true,
            outcome: "insufficient_data",
          }),
        }),
      );
    } finally {
      getItemSpy.mockRestore();
      getEvidenceSpy.mockRestore();
      gscCoverageSpy.mockRestore();
      updateSpy.mockRestore();
      addEventSpy.mockRestore();
    }
  });

  it("transitions to verified only when comparable newer evidence is sufficient", async () => {
    const getItemSpy = vi
      .spyOn(SeoActionRepository, "getItemById")
      .mockResolvedValue({
        ...baseCompletedItem,
        status: "verification_pending",
      });
    const getEvidenceSpy = vi
      .spyOn(SeoActionRepository, "getEvidenceForItem")
      .mockResolvedValue([
        {
          id: "ev-gsc-1",
          actionItemId: baseCompletedItem.id,
          source: "get_search_console_performance",
          provider: "google",
          sourceRecordId: null,
          metricName: "position",
          metricValue: "9.0",
          observationDate: "2026-11-20",
          observationRange: null,
          targetDevice: null,
          targetCountry: null,
          targetUrl: null,
          metadata: null,
        },
      ]);
    const gscCoverageSpy = vi
      .spyOn(GscSearchPerformanceRepository, "getStoredCoverageRange")
      .mockResolvedValue({
        startDate: "2026-10-01",
        endDate: "2026-11-25",
        totalDays: 56,
      });
    const gscRowsSpy = vi
      .spyOn(GscSearchPerformanceRepository, "getTableRows")
      .mockResolvedValue({
        rows: [
          {
            key: "تركيب عشب صناعي",
            clicks: 90,
            impressions: 1500,
            ctr: 0.06,
            position: 5.2,
          },
        ],
        hasNextPage: false,
      });
    const updateSpy = vi
      .spyOn(SeoActionRepository, "updateItem")
      .mockImplementation(async (_id, _proj, _org, updates) => ({
        ...baseCompletedItem,
        ...updates,
      }));
    const addEventSpy = vi
      .spyOn(SeoActionRepository, "addEvent")
      .mockResolvedValue({
        id: "evt-2",
        actionItemId: baseCompletedItem.id,
        actor: "user-1",
        previousStatus: "verification_pending",
        newStatus: "verified",
        notes: "",
        metadata: null,
        createdAt: new Date().toISOString(),
      });

    try {
      const result = await SeoActionVerificationEngine.verifyItem({
        itemId: baseCompletedItem.id,
        projectId: "proj-sports",
        organizationId: "org-a",
        actor: "user-1",
      });

      expect(result.outcome).toBe("implemented_improved");
      expect(result.evidenceSufficient).toBe(true);
      expect(result.awaitingNewerData).toBe(false);
      expect(result.status).toBe("verified");
      expect(result.item.status).toBe("verified");
      expect(result.item.verifiedAt).not.toBeNull();
      expect(isSufficientVerificationOutcome(result.outcome)).toBe(true);
    } finally {
      getItemSpy.mockRestore();
      getEvidenceSpy.mockRestore();
      gscCoverageSpy.mockRestore();
      gscRowsSpy.mockRestore();
      updateSpy.mockRestore();
      addEventSpy.mockRestore();
    }
  });

  it("rejects verification on tasks that are not completed or verification_pending", async () => {
    const getItemSpy = vi
      .spyOn(SeoActionRepository, "getItemById")
      .mockResolvedValue({
        ...baseCompletedItem,
        status: "in_progress",
      });

    try {
      await expect(
        SeoActionVerificationEngine.verifyItem({
          itemId: baseCompletedItem.id,
          projectId: "proj-sports",
          organizationId: "org-a",
          actor: "user-1",
        }),
      ).rejects.toThrow(InvalidStatusTransitionError);
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it("distinguishes completed, verification_pending/insufficient_data, and verified outcomes in UI display state", () => {
    const completedState = getVerificationDisplayState({
      status: "completed",
      verificationOutcome: null,
    });
    expect(completedState.statusLabel).toBe("Implementation Completed");
    expect(completedState.verificationAttempted).toBe(false);
    expect(completedState.canVerify).toBe(true);

    const insufficientState = getVerificationDisplayState({
      status: "verification_pending",
      verificationOutcome: "insufficient_data",
    });
    expect(insufficientState.statusLabel).toBe("Verification Pending");
    expect(insufficientState.verificationAttempted).toBe(true);
    expect(insufficientState.evidenceSufficient).toBe(false);
    expect(insufficientState.isAwaitingNewerData).toBe(true);
    expect(insufficientState.outcomeBadgeLabel).toContain(
      "Insufficient Evidence",
    );
    expect(insufficientState.outcomeBadgeLabel).toContain(
      "Awaiting Newer Data",
    );
    expect(insufficientState.canVerify).toBe(true);

    // Defensive check: even a legacy row marked verified + insufficient_data is NEVER shown as verified improvement
    const legacyInsufficientState = getVerificationDisplayState({
      status: "verified",
      verificationOutcome: "insufficient_data",
    });
    expect(legacyInsufficientState.statusLabel).toBe("Verification Pending");
    expect(legacyInsufficientState.outcomeTone).toBe("pending");
    expect(legacyInsufficientState.canVerify).toBe(true);

    const improvedState = getVerificationDisplayState({
      status: "verified",
      verificationOutcome: "implemented_improved",
    });
    expect(improvedState.statusLabel).toBe("Verified");
    expect(improvedState.evidenceSufficient).toBe(true);
    expect(improvedState.outcomeBadgeLabel).toBe(
      "Sufficient Evidence · Outcome: Improved",
    );
    expect(improvedState.outcomeTone).toBe("success");
    expect(improvedState.canVerify).toBe(false);
  });
});
