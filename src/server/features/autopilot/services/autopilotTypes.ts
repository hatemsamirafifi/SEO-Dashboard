import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  INTELLIGENCE_SOURCES,
  type DetectionSourceState,
  type SourceVersions,
} from "@/server/features/intelligence/services/SourceTokens";
import {
  AUTOPILOT_ATTEMPT_STATUSES,
  AUTOPILOT_RUN_STATUSES,
  AUTOPILOT_STEP_KINDS,
  type AutopilotAttemptStatus,
  type AutopilotRunStatus,
  type AutopilotStepKind,
  type AutopilotStepStatus,
} from "@/shared/autopilot";

export {
  AUTOPILOT_ATTEMPT_STATUSES,
  AUTOPILOT_RUN_STATUSES,
  AUTOPILOT_STEP_KINDS,
  type AutopilotAttemptStatus,
  type AutopilotRunStatus,
  type AutopilotStepKind,
  type AutopilotStepStatus,
};

// Autopilot runtime contracts (final-plan §13). PR15 ships the executor and
// the registration seam; workflow DEFINITIONS (step lists + prompts) are
// Task 16. Executor tests register synthetic definitions.

export const AUTOPILOT_MAX_STEPS = 12;
export const AUTOPILOT_MAX_TOOL_CALLS = 20;
/** Chosen default: twelve steps with room for retries and polling legs. */
export const AUTOPILOT_WALL_CLOCK_MS = 15 * 60 * 1000;
/** Source-changed invalidations before the run fails outright. */
export const AUTOPILOT_MAX_ATTEMPTS = 3;

export type AttemptPin = Pick<
  DetectionSourceState,
  "versions" | "sourceSet" | "detectorVersions" | "thresholdVersion"
>;

export function pinOf(state: DetectionSourceState): AttemptPin {
  return {
    versions: state.versions,
    sourceSet: state.sourceSet,
    detectorVersions: state.detectorVersions,
    thresholdVersion: state.thresholdVersion,
  };
}

function versionsRecordEqual(
  first: SourceVersions,
  second: SourceVersions,
): boolean {
  return INTELLIGENCE_SOURCES.every((key) => first[key] === second[key]);
}

export function versionsEqual(first: AttemptPin, second: AttemptPin): boolean {
  return (
    first.thresholdVersion === second.thresholdVersion &&
    first.sourceSet.length === second.sourceSet.length &&
    first.sourceSet.every((source) => second.sourceSet.includes(source)) &&
    versionsRecordEqual(first.versions, second.versions) &&
    JSON.stringify(first.detectorVersions) ===
      JSON.stringify(second.detectorVersions)
  );
}

export type PriorStepEvidence = {
  seq: number;
  kind: AutopilotStepKind;
  name: string;
  evidence: unknown;
  evidenceHash: string;
};

export type AutopilotStepContext = {
  projectId: string;
  organizationId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  pin: AttemptPin;
  pinHash: string;
  priorEvidence: PriorStepEvidence[];
  billingCustomer: BillingCustomerContext;
};

export type AutopilotStepResult = {
  /** JSON-serializable frozen evidence (serialization failure fails the step). */
  evidence: unknown;
  /** Budget units consumed (LLM tool calls; 0 for deterministic steps). */
  toolCalls?: number;
};

export type AutopilotStepDef = {
  seq: number;
  kind: AutopilotStepKind;
  name: string;
  /** Required for side_effect (domain-level dedupe); forbidden elsewhere. */
  idempotencyKey?: string;
  /** Transform steps may reuse completed evidence across attempts. */
  invariant?: boolean;
  run: (ctx: AutopilotStepContext) => Promise<AutopilotStepResult>;
};

export type AutopilotWorkflowDef = {
  type: string;
  steps: AutopilotStepDef[];
};

const registry = new Map<string, AutopilotWorkflowDef>();

export class DuplicateWorkflowError extends Error {}

/** Task-16 seam: workflow definitions register here; tests use synthetic ones. */
export function registerAutopilotWorkflow(def: AutopilotWorkflowDef): void {
  if (registry.has(def.type)) {
    throw new DuplicateWorkflowError(
      `Autopilot workflow already registered: ${def.type}`,
    );
  }
  const seqs = def.steps.map((step) => step.seq).toSorted((a, b) => a - b);
  for (const [index, seq] of seqs.entries()) {
    if (seq !== index) {
      throw new Error(
        `Autopilot workflow ${def.type} steps must be 0-based dense (found ${seq} at position ${index})`,
      );
    }
  }
  for (const step of def.steps) {
    if (step.kind === "side_effect" && !step.idempotencyKey) {
      throw new Error(
        `Autopilot workflow ${def.type} step ${step.seq} is side-effecting without an idempotency key`,
      );
    }
  }
  registry.set(def.type, def);
}

export function getAutopilotWorkflow(
  type: string,
): AutopilotWorkflowDef | null {
  return registry.get(type) ?? null;
}

export function clearAutopilotWorkflows(): void {
  registry.clear();
}
