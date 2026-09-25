import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { stableHash } from "@/shared/intelligence";
import {
  hashSourceState,
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { AutopilotBudgets } from "./autopilotBudgets";
import {
  AUTOPILOT_STEP_KINDS,
  pinOf,
  type AttemptPin,
  type AutopilotStepContext,
  type AutopilotStepDef,
  type AutopilotWorkflowDef,
  type PriorStepEvidence,
} from "./autopilotTypes";

export type AttemptOutcome =
  | { outcome: "completed"; evidenceHash: string }
  | { outcome: "invalidated"; reason: string }
  | { outcome: "failed"; error: string; errorClass: string }
  | { outcome: "cancelled" };

/**
 * Minimal durable-step surface. The real Cloudflare WorkflowStep satisfies
 * this structurally (same call shapes as pgStep); tests supply an inline
 * fake. Each step body re-scopes the PG client like pgStep because ALS
 * never crosses step boundaries.
 */
export type StepRunner = {
  do(
    name: string,
    config: unknown,
    fn: () => Promise<unknown>,
  ): Promise<unknown>;
};

function isCollectOutcome(value: unknown): value is { invalidated: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "invalidated" in value &&
    typeof value.invalidated === "boolean"
  );
}

export async function durableCollectStep(
  runner: StepRunner,
  name: string,
  config: unknown,
  fn: () => Promise<{ invalidated: boolean }>,
): Promise<{ invalidated: boolean }> {
  const outcome = await runner.do(name, config, () => withPgClient(fn));
  if (!isCollectOutcome(outcome)) {
    throw new AppError("INTERNAL_ERROR", "Collect step returned no verdict");
  }
  return outcome;
}

export async function durableSimpleStep(
  runner: StepRunner,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  await runner.do(name, undefined, () => withPgClient(fn));
}

export class AutopilotCancelledError extends Error {}

export function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 200);
}

export function workflowStepName(
  runId: string,
  attemptNumber: number,
  def: AutopilotStepDef,
): string {
  return `${runId}-a${attemptNumber}-s${def.seq}-${def.name}`;
}

export async function posthog(
  billingCustomer: BillingCustomerContext,
  event: string,
  properties: Record<string, string | number>,
  projectId: string,
): Promise<void> {
  await captureServerEvent({
    distinctId: billingCustomer.userId,
    event,
    organizationId: billingCustomer.organizationId,
    properties: { project_id: projectId, ...properties },
  });
}

export async function failRun(input: {
  runId: string;
  projectId: string;
  organizationId: string;
  billingCustomer: BillingCustomerContext;
  workflowType: string;
  error: string;
  errorClass: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await AutopilotRepository.updateRun(input.runId, {
    status: "failed",
    error: truncateError(input.error),
    errorClass: input.errorClass,
    completedAt: now,
  });
  console.log(
    `[autopilot:${input.runId}] failed class=${input.errorClass} error="${truncateError(input.error)}"`,
  );
  await posthog(
    input.billingCustomer,
    "autopilot:fail",
    { workflow_type: input.workflowType, error_class: input.errorClass },
    input.projectId,
  );
}

export async function currentPinHash(
  projectId: string,
): Promise<{ pin: AttemptPin; pinHash: string }> {
  const state: DetectionSourceState =
    await SourceTokens.assembleDetectionSourceState(projectId);
  const pin = pinOf(state);
  return { pin, pinHash: await hashSourceState(pin) };
}

export async function creditCheck(input: {
  billingCustomer: BillingCustomerContext;
}): Promise<boolean> {
  if (!(await AutopilotBudgets.isHostedMode())) return false;
  const { depleted } = await AutopilotBudgets.checkCreditsDepleted({
    userId: input.billingCustomer.userId,
    userEmail: input.billingCustomer.userEmail,
    organizationId: input.billingCustomer.organizationId,
    projectId: input.billingCustomer.projectId,
  });
  return depleted;
}

export function serializeEvidence(evidence: unknown): string {
  try {
    return JSON.stringify(evidence) ?? "null";
  } catch {
    throw new AppError("INTERNAL_ERROR", "Step evidence is not serializable");
  }
}

export async function evidenceHashOf(
  evidenceJson: string,
  pinHash: string,
): Promise<string> {
  return stableHash({ evidenceJson, pinHash });
}

export type AttemptDrive = {
  runId: string;
  projectId: string;
  organizationId: string;
  attemptId: string;
  attemptNumber: number;
  pin: AttemptPin;
  pinHash: string;
  workflow: AutopilotWorkflowDef;
  billingCustomer: BillingCustomerContext;
  stepRunner: StepRunner;
  startedAtMs: number;
};

export async function runCollectStep(
  drive: AttemptDrive,
  def: AutopilotStepDef,
  ctx: AutopilotStepContext,
  collectionAttempts: number,
): Promise<{ invalidated: boolean }> {
  const before = await currentPinHash(drive.projectId);
  if (before.pinHash !== drive.pinHash) {
    return { invalidated: true };
  }
  const result = await def.run(ctx);
  const after = await currentPinHash(drive.projectId);
  await AutopilotRepository.updateStep(drive.attemptId, def.seq, {
    collectionAttempts: collectionAttempts + 1,
  });
  if (after.pinHash !== drive.pinHash) {
    return { invalidated: true };
  }
  const evidenceJson = serializeEvidence(result.evidence);
  await AutopilotRepository.updateStep(drive.attemptId, def.seq, {
    status: "completed",
    evidenceJson,
    evidenceHash: await evidenceHashOf(evidenceJson, drive.pinHash),
    effectiveSourceVersionsJson: JSON.stringify(drive.pin),
    toolCalls: result.toolCalls ?? 0,
  });
  return { invalidated: false };
}

export async function runSimpleStep(
  drive: AttemptDrive,
  def: AutopilotStepDef,
  ctx: AutopilotStepContext,
): Promise<void> {
  const result = await def.run(ctx);
  const evidenceJson = serializeEvidence(result.evidence);
  await AutopilotRepository.updateStep(drive.attemptId, def.seq, {
    status: "completed",
    evidenceJson,
    evidenceHash: await evidenceHashOf(evidenceJson, drive.pinHash),
    effectiveSourceVersionsJson: JSON.stringify(drive.pin),
    toolCalls: result.toolCalls ?? 0,
  });
}

export async function reuseInvariantStep(
  drive: AttemptDrive,
  def: AutopilotStepDef,
  runId: string,
): Promise<boolean> {
  if (!def.invariant) return false;
  const siblings = await AutopilotRepository.listStepsByRun(runId);
  const donor = siblings.find(
    (row) =>
      row.seq === def.seq &&
      row.attemptId !== drive.attemptId &&
      row.status === "completed" &&
      row.evidenceJson !== null,
  );
  if (!donor?.evidenceJson) return false;
  await AutopilotRepository.updateStep(drive.attemptId, def.seq, {
    status: "completed",
    evidenceJson: donor.evidenceJson,
    evidenceHash: donor.evidenceHash,
    effectiveSourceVersionsJson: donor.effectiveSourceVersionsJson,
    toolCalls: 0,
    reusedFromAttempt: donor.attemptId,
  });
  return true;
}

export function isStepKind(value: string): value is PriorStepEvidence["kind"] {
  return (AUTOPILOT_STEP_KINDS as readonly string[]).includes(value);
}

export function toPriorEvidence(
  rows: {
    seq: number;
    kind: string;
    name: string;
    evidenceJson: string | null;
    evidenceHash: string | null;
  }[],
): PriorStepEvidence[] {
  return rows.flatMap((row) => {
    if (row.evidenceJson === null || row.evidenceHash === null) return [];
    if (!isStepKind(row.kind)) return [];
    let evidence: unknown = null;
    try {
      evidence = JSON.parse(row.evidenceJson) as unknown;
    } catch {
      return [];
    }
    return [
      {
        seq: row.seq,
        kind: row.kind,
        name: row.name,
        evidence,
        evidenceHash: row.evidenceHash,
      },
    ];
  });
}

export async function failAttempt(
  drive: AttemptDrive,
  error: string,
): Promise<AttemptOutcome> {
  await AutopilotRepository.updateAttempt(drive.attemptId, {
    status: "failed",
    completedAt: new Date().toISOString(),
  });
  return { outcome: "failed", error, errorClass: "STEP_FAILED" };
}

export async function invalidateAttempt(
  drive: AttemptDrive,
  collectionAttempts: number,
): Promise<AttemptOutcome> {
  await AutopilotRepository.updateAttempt(drive.attemptId, {
    status: "invalidated",
    invalidationReason: "SOURCE_CHANGED",
    completedAt: new Date().toISOString(),
  });
  console.log(
    `[autopilot:${drive.runId}] attempt ${drive.attemptNumber} invalidated (SOURCE_CHANGED)`,
  );
  await posthog(
    drive.billingCustomer,
    "autopilot:collection_retry",
    {
      workflow_type: drive.workflow.type,
      attempt_number: drive.attemptNumber,
      collection_attempts: collectionAttempts,
      attempt_invalidated: 1,
    },
    drive.projectId,
  );
  return { outcome: "invalidated", reason: "SOURCE_CHANGED" };
}
