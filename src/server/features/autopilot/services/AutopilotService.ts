import { waitUntil } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { ensureAutopilotWorkflowsRegistered } from "./autopilotWorkflows";
import { driveRunToCompletion, type StepRunner } from "./stepExecutor";

ensureAutopilotWorkflowsRegistered();
import {
  getAutopilotWorkflow,
  type AutopilotWorkflowDef,
} from "./autopilotTypes";

export type AutopilotRunView = {
  run: Exclude<Awaited<ReturnType<typeof AutopilotRepository.getRun>>, null>;
  attempts: Awaited<ReturnType<typeof AutopilotRepository.listAttemptsByRun>>;
  steps: Awaited<ReturnType<typeof AutopilotRepository.listStepsByRun>>;
};

function workflowBinding() {
  // Unbound in tests (and any env without the binding): fail loudly.
  const binding = env.AUTOPILOT_WORKFLOW;
  if (!binding) throw new AppError("INTERNAL_ERROR", "Autopilot unavailable");
  return binding;
}

function billingCustomerFor(input: {
  userId?: string;
  userEmail: string;
  organizationId: string;
  projectId: string;
}): BillingCustomerContext {
  return {
    userId: input.userId ?? input.organizationId,
    userEmail: input.userEmail,
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
}

/**
 * Orphan reconciler (mirrors the audit self-heal): running rows whose live
 * instance is gone, errored, or terminated are marked failed so they stop
 * holding budgets and polling UIs. Bounded to running rows of one project.
 */
export async function reconcileAutopilotRuns(input: {
  projectId: string;
}): Promise<{ reconciled: string[] }> {
  const reconciled: string[] = [];
  const running = await AutopilotRepository.listRunningRuns(input.projectId);
  if (running.length === 0) return { reconciled };
  const binding = workflowBinding();
  for (const run of running) {
    let instanceStatus: string | null = null;
    try {
      const instance = await binding.get(run.id);
      instanceStatus = (await instance.status()).status;
    } catch {
      instanceStatus = null;
    }
    if (
      instanceStatus === null ||
      instanceStatus === "errored" ||
      instanceStatus === "terminated"
    ) {
      await AutopilotRepository.updateRun(run.id, {
        status: "failed",
        error: "Workflow instance lost before completion",
        errorClass: "ORPHANED_INSTANCE",
        completedAt: new Date().toISOString(),
      });
      reconciled.push(run.id);
    }
  }
  return { reconciled };
}

async function runView(
  runId: string,
  projectId: string,
): Promise<AutopilotRunView | null> {
  const run = await AutopilotRepository.getRunForProject(runId, projectId);
  if (!run) return null;
  const [attempts, steps] = await Promise.all([
    AutopilotRepository.listAttemptsByRun(run.id),
    AutopilotRepository.listStepsByRun(run.id),
  ]);
  return { run, attempts, steps };
}

export async function startAutopilotRun(input: {
  projectId: string;
  organizationId: string;
  userId?: string;
  userEmail: string;
  workflowType: string;
  trigger?: string;
}): Promise<{ runId: string }> {
  const workflow: AutopilotWorkflowDef | null = getAutopilotWorkflow(
    input.workflowType,
  );
  if (!workflow) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Unknown autopilot workflow: ${input.workflowType}`,
    );
  }
  await reconcileAutopilotRuns({ projectId: input.projectId });
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  await AutopilotRepository.insertRun({
    id: runId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    workflowType: input.workflowType,
    status: "pending",
    startedByUserId: input.userId ?? null,
    trigger: input.trigger ?? "manual",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const billingCustomer = billingCustomerFor({
    userId: input.userId,
    userEmail: input.userEmail,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  try {
    await workflowBinding().create({
      id: runId,
      params: {
        runId,
        projectId: input.projectId,
        organizationId: input.organizationId,
        workflowType: input.workflowType,
        billingCustomer,
      },
    });
  } catch (error) {
    await AutopilotRepository.updateRun(runId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Workflow start failed",
      errorClass: "WORKFLOW_START_FAILED",
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
  console.log(`[autopilot:${runId}] started type=${input.workflowType}`);
  waitUntil(
    captureServerEvent({
      distinctId: input.userId ?? input.organizationId,
      event: "autopilot:start",
      organizationId: input.organizationId,
      properties: {
        project_id: input.projectId,
        workflow_type: input.workflowType,
      },
    }),
  );
  return { runId };
}

export async function getAutopilotRun(input: {
  runId: string;
  projectId: string;
}): Promise<AutopilotRunView | null> {
  await reconcileAutopilotRuns({ projectId: input.projectId });
  return runView(input.runId, input.projectId);
}

export async function listAutopilotRuns(input: {
  projectId: string;
}): Promise<Awaited<ReturnType<typeof AutopilotRepository.listRunsByProject>>> {
  return AutopilotRepository.listRunsByProject(input.projectId);
}

export async function cancelAutopilotRun(input: {
  runId: string;
  projectId: string;
  organizationId: string;
  userId?: string;
}): Promise<{ status: string }> {
  const run = await AutopilotRepository.getRunForProject(
    input.runId,
    input.projectId,
  );
  if (!run) throw new AppError("NOT_FOUND", "Autopilot run not found");
  if (run.status === "completed" || run.status === "failed") {
    return { status: run.status };
  }
  try {
    const instance = await workflowBinding().get(run.id);
    await instance.terminate();
  } catch (error) {
    console.error(`[autopilot:${run.id}] terminate failed`, error);
  }
  await AutopilotRepository.updateRun(run.id, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
  });
  return { status: "cancelled" };
}

export async function resumeAutopilotRun(input: {
  runId: string;
  projectId: string;
  organizationId: string;
  userId?: string;
  userEmail: string;
}): Promise<{ runId: string; resumed: boolean }> {
  const run = await AutopilotRepository.getRunForProject(
    input.runId,
    input.projectId,
  );
  if (!run) throw new AppError("NOT_FOUND", "Autopilot run not found");
  if (run.status === "completed" || run.status === "failed") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only running or cancelled runs can resume",
    );
  }
  let instanceAlive = false;
  try {
    const instance = await workflowBinding().get(run.id);
    instanceAlive = (await instance.status()).status === "running";
  } catch {
    instanceAlive = false;
  }
  if (instanceAlive) return { runId: run.id, resumed: false };
  const billingCustomer = billingCustomerFor({
    userId: input.userId,
    userEmail: input.userEmail,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  try {
    await workflowBinding().create({
      id: run.id,
      params: {
        runId: run.id,
        projectId: input.projectId,
        organizationId: input.organizationId,
        workflowType: run.workflowType,
        billingCustomer,
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /already exists|duplicate|conflict/i.test(error.message)
    ) {
      return { runId: run.id, resumed: false };
    }
    throw error;
  }
  await AutopilotRepository.updateRun(run.id, { status: "running" });
  return { runId: run.id, resumed: true };
}

/** Workflow-entry drive: resolves the registered definition and runs it. */
export async function driveWorkflowRun(input: {
  runId: string;
  projectId: string;
  organizationId: string;
  workflowType: string;
  billingCustomer: BillingCustomerContext;
  stepRunner: StepRunner;
}): Promise<{ status: string }> {
  const workflow = getAutopilotWorkflow(input.workflowType);
  if (!workflow) {
    await AutopilotRepository.updateRun(input.runId, {
      status: "failed",
      error: `Unknown autopilot workflow: ${input.workflowType}`,
      errorClass: "UNKNOWN_WORKFLOW",
      completedAt: new Date().toISOString(),
    });
    return { status: "failed" };
  }
  return driveRunToCompletion({
    runId: input.runId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    workflow,
    billingCustomer: input.billingCustomer,
    stepRunner: input.stepRunner,
  });
}

export const AutopilotService = {
  startAutopilotRun,
  getAutopilotRun,
  listAutopilotRuns,
  cancelAutopilotRun,
  resumeAutopilotRun,
  reconcileAutopilotRuns,
  driveWorkflowRun,
};
