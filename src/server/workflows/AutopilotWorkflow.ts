import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { driveWorkflowRun } from "@/server/features/autopilot/services/AutopilotService";

export type AutopilotWorkflowParams = {
  runId: string;
  projectId: string;
  organizationId: string;
  workflowType: string;
  billingCustomer: BillingCustomerContext;
};

/**
 * Durable autopilot execution (final-plan §13). Instance id == run id.
 * Crash between steps resumes by step identity; the executor re-gates
 * collections against the attempt pin, so a resume never mixes evidence
 * universes. Cancel terminates the instance; resume creates a continuation
 * bound to the same run row.
 */
export class AutopilotWorkflow extends WorkflowEntrypoint<
  Env,
  AutopilotWorkflowParams
> {
  async run(event: WorkflowEvent<AutopilotWorkflowParams>, step: WorkflowStep) {
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<AutopilotWorkflowParams>,
    step: WorkflowStep,
  ) {
    const { runId, projectId, organizationId, workflowType, billingCustomer } =
      event.payload;
    console.log(`[autopilot:${runId}] workflow started type=${workflowType}`);
    // Executor attempt steps are top-level engine steps (unique
    // run-attempt-seq names), so a crash between steps replays from step
    // identity — never nested inside a wrapper step.
    return driveWorkflowRun({
      runId,
      projectId,
      organizationId,
      workflowType,
      billingCustomer,
      stepRunner: step,
    });
  }
}
