// Shared autopilot contracts (final-plan §13). Workflow type identity lives
// here so the server definitions, MCP tools, and SAM UI reference one list
// without the client importing server modules. Status/step-kind unions also
// live here (server autopilotTypes re-exports them) so client readers stay
// typed without importing server-only modules. No detection, scoring, or
// causal language belongs in this file.

export const AUTOPILOT_WORKFLOW_TYPES = [
  "growth_plan",
  "quick_wins",
  "traffic_drop",
] as const;
export type AutopilotWorkflowType = (typeof AUTOPILOT_WORKFLOW_TYPES)[number];

export const AUTOPILOT_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AutopilotRunStatus = (typeof AUTOPILOT_RUN_STATUSES)[number];

export const AUTOPILOT_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "invalidated",
] as const;
export type AutopilotAttemptStatus =
  (typeof AUTOPILOT_ATTEMPT_STATUSES)[number];

export const AUTOPILOT_STEP_KINDS = [
  "collect",
  "correlate",
  "transform",
  "synthesize",
  "side_effect",
] as const;
export type AutopilotStepKind = (typeof AUTOPILOT_STEP_KINDS)[number];

export type AutopilotStepStatus =
  | Extract<AutopilotAttemptStatus, "pending" | "running" | "completed" | "failed">;

export function isAutopilotWorkflowType(
  value: unknown,
): value is AutopilotWorkflowType {
  return (AUTOPILOT_WORKFLOW_TYPES as readonly unknown[]).includes(value);
}

export const AUTOPILOT_WORKFLOW_LABELS: Record<AutopilotWorkflowType, string> =
  {
    growth_plan: "Growth plan",
    quick_wins: "Quick wins",
    traffic_drop: "Traffic drop",
  };

export const AUTOPILOT_WORKFLOW_DESCRIPTIONS: Record<
  AutopilotWorkflowType,
  string
> = {
  growth_plan:
    "Ranked plan from engine output. Highest stored priority first, with metrics and periods on every move.",
  quick_wins: "Small reversible moves from Critical and High items only.",
  traffic_drop:
    "Overlap table across signals for a traffic move. Single-source rows stay provisional.",
};

export const AUTOPILOT_STEP_KIND_LABELS: Record<AutopilotStepKind, string> = {
  collect: "Collect",
  correlate: "Correlate",
  transform: "Transform",
  synthesize: "Synthesize",
  side_effect: "Side effect",
};

export const AUTOPILOT_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export function isAutopilotRunActive(status: AutopilotRunStatus): boolean {
  return status === "pending" || status === "running";
}
