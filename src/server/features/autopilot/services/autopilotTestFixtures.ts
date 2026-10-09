import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import type { StepRunner } from "./stepExecutor";
import type { AutopilotStepDef, AutopilotWorkflowDef } from "./autopilotTypes";
import type { DetectionSourceState } from "@/server/features/intelligence/services/SourceTokens";
import type { OpportunityRow } from "@/server/features/intelligence/repositories/OpportunityRepository";

// Shared builders for autopilot service tests (final-plan §19 fixtures).
// Source reads are stubbed at the SourceTokens seam per test; these cover
// everything else a drive needs.

export function sourceState(version: string | null): DetectionSourceState {
  return {
    versions: {
      gsc: version,
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
    },
    sourceSet: version === null ? [] : ["gsc"],
    detectorVersions: {},
    thresholdVersion: 2,
    activeMutations: {
      gsc: { isMutating: false, activeRunIds: [] },
      ga4: { isMutating: false, activeRunIds: [] },
      rank: { isMutating: false, activeRunIds: [] },
      audit: { isMutating: false, activeRunIds: [] },
      backlinks: { isMutating: false, activeRunIds: [] },
    },
  };
}

export const BILLING: BillingCustomerContext = {
  userId: "user-1",
  userEmail: "owner@example.com",
  organizationId: "org-1",
  projectId: "project-1",
};

export function makeOpportunity(
  overrides: Partial<OpportunityRow> & { id: string },
): OpportunityRow {
  const now = "2026-09-20T00:00:00.000Z";
  return {
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey: "organic_traffic_change:/pricing",
    occurrenceNumber: 1,
    type: "organic_traffic_change",
    detectorKey: "organic_traffic_change",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 72,
    confidenceScore: 68,
    priority: "High",
    title: "Pricing traffic moved",
    explanationFact: "Clicks moved in the window",
    recommendation: "Inspect the page",
    evidenceJson: "{}",
    keyword: null,
    page: "/pricing",
    sourceMetricsJson: null,
    sourcesJson: "[]",
    impactFactorsJson: null,
    confidenceInputsJson: null,
    lastSeenScanId: null,
    consecutiveMisses: 0,
    stale: false,
    staleAt: null,
    recurrenceOfId: null,
    supersededById: null,
    firstDetectedAt: now,
    lastDetectedAt: now,
    completedAt: null,
    dismissedAt: null,
    dismissalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function fakeRunner(): StepRunner {
  return {
    do: (_name, _config, fn) => fn(),
  };
}

export function collectStep(
  name: string,
  evidence: unknown,
  seq = 0,
): AutopilotStepDef {
  return {
    seq,
    kind: "collect",
    name,
    run: async () => ({ evidence }),
  };
}

export function computeStep(
  name: string,
  evidence: Record<string, unknown>,
  seq = 1,
): AutopilotStepDef {
  return {
    seq,
    kind: "correlate",
    name,
    run: async (ctx) => ({
      evidence: { ...evidence, inputs: ctx.priorEvidence.length },
    }),
  };
}

export function workflowDef(steps: AutopilotStepDef[]): AutopilotWorkflowDef {
  return { type: "test-flow", steps };
}

export async function seedRun(): Promise<string> {
  const run = await AutopilotRepository.insertRun({
    id: crypto.randomUUID(),
    projectId: "project-1",
    organizationId: "org-1",
    workflowType: "test-flow",
    status: "pending",
    trigger: "manual",
  });
  return run.id;
}
