import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { stableHash } from "@/shared/intelligence";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { AutopilotBudgets } from "./autopilotBudgets";
import {
  AUTOPILOT_MAX_ATTEMPTS,
  AUTOPILOT_MAX_STEPS,
  AUTOPILOT_MAX_TOOL_CALLS,
  AUTOPILOT_WALL_CLOCK_MS,
  type AttemptPin,
  type AutopilotStepContext,
  type AutopilotWorkflowDef,
} from "./autopilotTypes";
import {
  creditCheck,
  currentPinHash,
  durableCollectStep,
  durableSimpleStep,
  failAttempt,
  failRun,
  invalidateAttempt,
  posthog,
  runCollectStep,
  runSimpleStep,
  reuseInvariantStep,
  toPriorEvidence,
  truncateError,
  workflowStepName,
  AutopilotCancelledError,
  type AttemptDrive,
  type AttemptOutcome,
  type StepRunner,
} from "./stepSupport";
import { parseStoredPin } from "./synthesisFirewall";

export type { AttemptOutcome, StepRunner } from "./stepSupport";

/**
 * Drives one attempt through every step (final-plan §13). Collect steps
 * dual-gate against the attempt pin; any mismatch invalidates the attempt
 * without persisting the discarded collection.
 */
export async function runAttempt(drive: AttemptDrive): Promise<AttemptOutcome> {
  const previous = await AutopilotRepository.getAttempt(drive.attemptId);
  await AutopilotRepository.updateAttempt(drive.attemptId, {
    status: "running",
    startedAt: previous?.startedAt ?? new Date().toISOString(),
  });
  const provider = await AutopilotBudgets.resolveProvider({
    env: {},
    projectId: drive.projectId,
    organizationId: drive.organizationId,
  }).catch(() => null);
  console.log(
    `[autopilot:${drive.runId}] attempt ${drive.attemptNumber} started provider=${provider?.provider ?? "unconfigured"}`,
  );

  let toolCallsUsed = 0;
  let stepsExecuted = 0;
  for (const def of drive.workflow.steps) {
    const run = await AutopilotRepository.getRun(drive.runId);
    if (!run || run.status === "cancelled") throw new AutopilotCancelledError();
    if (Date.now() - drive.startedAtMs > AUTOPILOT_WALL_CLOCK_MS) {
      await failAttempt(drive, "Autopilot wall clock exceeded");
      return {
        outcome: "failed",
        error: "Autopilot wall clock exceeded",
        errorClass: "WALL_CLOCK_EXCEEDED",
      };
    }
    if (await creditCheck({ billingCustomer: drive.billingCustomer })) {
      await failAttempt(drive, "Insufficient credits");
      return {
        outcome: "failed",
        error: "Insufficient credits",
        errorClass: "INSUFFICIENT_CREDITS",
      };
    }
    if (stepsExecuted + 1 > AUTOPILOT_MAX_STEPS) {
      await failAttempt(drive, "Autopilot step budget exceeded");
      return {
        outcome: "failed",
        error: "Autopilot step budget exceeded",
        errorClass: "STEP_BUDGET_EXCEEDED",
      };
    }

    await AutopilotRepository.insertStepIgnoreConflict({
      id: crypto.randomUUID(),
      attemptId: drive.attemptId,
      runId: drive.runId,
      seq: def.seq,
      kind: def.kind,
      name: def.name,
      status: "pending",
      idempotencyKey: def.idempotencyKey ?? null,
    });
    const existing = await AutopilotRepository.getStep(
      drive.attemptId,
      def.seq,
    );
    if (existing?.status === "completed") {
      toolCallsUsed += existing.toolCalls;
      stepsExecuted += 1;
      continue;
    }
    if (await reuseInvariantStep(drive, def, drive.runId)) {
      stepsExecuted += 1;
      continue;
    }

    const priorEvidence = toPriorEvidence(
      await AutopilotRepository.listStepsByAttempt(drive.attemptId),
    );
    const ctx: AutopilotStepContext = {
      projectId: drive.projectId,
      organizationId: drive.organizationId,
      runId: drive.runId,
      attemptId: drive.attemptId,
      attemptNumber: drive.attemptNumber,
      pin: drive.pin,
      pinHash: drive.pinHash,
      priorEvidence,
      billingCustomer: drive.billingCustomer,
    };
    const name = workflowStepName(drive.runId, drive.attemptNumber, def);
    try {
      if (def.kind === "collect") {
        const collectionAttempts = existing?.collectionAttempts ?? 0;
        const { invalidated } = await durableCollectStep(
          drive.stepRunner,
          name,
          { retries: { limit: 2, delay: "5 seconds" } },
          () => runCollectStep(drive, def, ctx, collectionAttempts),
        );
        if (invalidated)
          return invalidateAttempt(drive, collectionAttempts + 1);
      } else {
        await durableSimpleStep(drive.stepRunner, name, () =>
          runSimpleStep(drive, def, ctx),
        );
      }
    } catch (error) {
      await AutopilotRepository.updateStep(drive.attemptId, def.seq, {
        status: "failed",
        error: truncateError(error),
      });
      return failAttempt(drive, truncateError(error));
    }
    const finished = await AutopilotRepository.getStep(
      drive.attemptId,
      def.seq,
    );
    toolCallsUsed += finished?.toolCalls ?? 0;
    if (toolCallsUsed > AUTOPILOT_MAX_TOOL_CALLS) {
      await failAttempt(drive, "Autopilot tool-call budget exceeded");
      return {
        outcome: "failed",
        error: "Autopilot tool-call budget exceeded",
        errorClass: "TOOL_CALL_BUDGET_EXCEEDED",
      };
    }
    stepsExecuted += 1;
  }

  // A cancel that raced the final step wins over completion: the attempt
  // stays runnable so resume continues it instead of starting over.
  const closing = await AutopilotRepository.getRun(drive.runId);
  if (!closing || closing.status === "cancelled") {
    return { outcome: "cancelled" };
  }
  const finished = await AutopilotRepository.listStepsByAttempt(
    drive.attemptId,
  );
  const evidenceHash = await stableHash(
    finished.map((row) => row.evidenceHash ?? ""),
  );
  await AutopilotRepository.updateAttempt(drive.attemptId, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  return { outcome: "completed", evidenceHash };
}

export type DriveRunInput = {
  runId: string;
  projectId: string;
  organizationId: string;
  workflow: AutopilotWorkflowDef;
  billingCustomer: BillingCustomerContext;
  stepRunner: StepRunner;
};

/** The attempt a drive continues: current pending/running, if any. */
async function currentRunnableAttempt(runId: string) {
  const run = await AutopilotRepository.getRun(runId);
  if (!run?.currentAttemptId) return null;
  const attempt = await AutopilotRepository.getAttempt(run.currentAttemptId);
  if (
    !attempt ||
    attempt.runId !== runId ||
    (attempt.status !== "pending" && attempt.status !== "running")
  ) {
    return null;
  }
  return attempt;
}

/**
 * Drives the run to a terminal state (completed, failed, or cancelled).
 * The current pending/running attempt is resumed (same pin, completed steps
 * skipped); otherwise a fresh pinned attempt starts. Invalidated attempts
 * retry up to AUTOPILOT_MAX_ATTEMPTS; exhaustion fails the run as
 * SOURCE_CHANGED_DURING_AUTOPILOT.
 */
export async function driveRunToCompletion(
  input: DriveRunInput,
): Promise<{ status: string; evidenceHash?: string }> {
  const started = await AutopilotRepository.getRun(input.runId);
  if (!started) throw new AppError("NOT_FOUND", "Autopilot run not found");
  if (started.status === "completed" || started.status === "failed") {
    return {
      status: started.status,
      evidenceHash: started.evidenceHash ?? undefined,
    };
  }
  await AutopilotRepository.updateRun(input.runId, {
    status: "running",
    startedAt: started.startedAt ?? new Date().toISOString(),
  });

  for (;;) {
    const current = await currentRunnableAttempt(input.runId);
    let attemptId: string;
    let attemptNumber: number;
    let pin: AttemptPin;
    let pinHash: string;
    let startedAtMs: number;
    if (current) {
      pin = parseStoredPin(current);
      pinHash = current.sourceVersionsHash;
      attemptId = current.id;
      attemptNumber = current.attemptNumber;
      startedAtMs = current.startedAt
        ? Date.parse(current.startedAt)
        : Date.now();
    } else {
      const existing = await AutopilotRepository.listAttemptsByRun(input.runId);
      if (existing.length >= AUTOPILOT_MAX_ATTEMPTS) {
        await failRun({
          runId: input.runId,
          projectId: input.projectId,
          organizationId: input.organizationId,
          billingCustomer: input.billingCustomer,
          workflowType: input.workflow.type,
          error:
            "Sources changed during every collection attempt; retry the run later.",
          errorClass: "SOURCE_CHANGED_DURING_AUTOPILOT",
        });
        return { status: "failed" };
      }
      const created = await currentPinHash(input.projectId);
      pin = created.pin;
      pinHash = created.pinHash;
      attemptNumber = existing.length + 1;
      const attempt = await AutopilotRepository.insertAttempt({
        id: crypto.randomUUID(),
        runId: input.runId,
        attemptNumber,
        sourceVersionsJson: JSON.stringify(pin),
        sourceVersionsHash: pinHash,
        status: "pending",
      });
      const superseded = existing[existing.length - 1];
      if (superseded) {
        await AutopilotRepository.updateAttempt(superseded.id, {
          supersededByAttemptId: attempt.id,
        });
      }
      attemptId = attempt.id;
      startedAtMs = Date.now();
      await AutopilotRepository.updateRun(input.runId, {
        currentAttemptId: attempt.id,
      });
    }
    let outcome: AttemptOutcome;
    try {
      outcome = await runAttempt({
        runId: input.runId,
        projectId: input.projectId,
        organizationId: input.organizationId,
        attemptId,
        attemptNumber,
        pin,
        pinHash,
        workflow: input.workflow,
        billingCustomer: input.billingCustomer,
        stepRunner: input.stepRunner,
        startedAtMs,
      });
    } catch (error) {
      if (error instanceof AutopilotCancelledError) {
        return { status: "cancelled" };
      }
      throw error;
    }
    if (outcome.outcome === "completed") {
      const now = new Date().toISOString();
      await AutopilotRepository.updateRun(input.runId, {
        status: "completed",
        evidenceHash: outcome.evidenceHash,
        completedAt: now,
      });
      console.log(`[autopilot:${input.runId}] completed`);
      await posthog(
        input.billingCustomer,
        "autopilot:complete",
        { workflow_type: input.workflow.type, attempts: attemptNumber },
        input.projectId,
      );
      return { status: "completed", evidenceHash: outcome.evidenceHash };
    }
    if (outcome.outcome === "cancelled") return { status: "cancelled" };
    if (outcome.outcome === "invalidated") continue;
    if (outcome.outcome === "failed") {
      const previous = await AutopilotRepository.getAttempt(attemptId);
      if (previous && previous.status !== "failed") {
        await AutopilotRepository.updateAttempt(attemptId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
      }
      await failRun({
        runId: input.runId,
        projectId: input.projectId,
        organizationId: input.organizationId,
        billingCustomer: input.billingCustomer,
        workflowType: input.workflow.type,
        error: outcome.error,
        errorClass: outcome.errorClass,
      });
      return { status: "failed" };
    }
  }
}
