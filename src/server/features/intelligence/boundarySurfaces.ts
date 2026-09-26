// Shared lock surfaces for the boundary tests (final-plan §§12–14).
// Extracted from intelligence-boundaries.test.ts so that file stays within
// the repo max-lines gate as Task 16 extends the autopilot surface.

export const AUTOPILOT_FILES = [
  "src/server/features/autopilot/repositories/AutopilotRepository.ts",
  "src/server/features/autopilot/services/autopilotTypes.ts",
  "src/server/features/autopilot/services/autopilotBudgets.ts",
  "src/server/features/autopilot/services/stepSupport.ts",
  "src/server/features/autopilot/services/stepExecutor.ts",
  "src/server/features/autopilot/services/synthesisFirewall.ts",
  "src/server/features/autopilot/services/autopilotSerializer.ts",
  "src/server/features/autopilot/services/autopilotWorkflowContent.ts",
  "src/server/features/autopilot/services/autopilotWorkflows.ts",
  "src/server/features/autopilot/services/AutopilotService.ts",
  "src/server/workflows/AutopilotWorkflow.ts",
  "src/serverFunctions/autopilot.ts",
  "src/types/schemas/autopilot.ts",
];

export const AUTOPILOT_COPY_FILES = [
  "src/server/features/autopilot/services/stepSupport.ts",
  "src/server/features/autopilot/services/stepExecutor.ts",
  "src/server/features/autopilot/services/AutopilotService.ts",
  "src/server/features/autopilot/services/autopilotSerializer.ts",
  "src/server/features/autopilot/services/autopilotWorkflowContent.ts",
  "src/server/features/autopilot/services/autopilotWorkflows.ts",
  "src/server/workflows/AutopilotWorkflow.ts",
];

export const MCP_UI_COPY_FILES = [
  "src/shared/autopilot.ts",
  "src/server/mcp/tools/intelligence-tools.ts",
  "src/server/mcp/tools/analytics-tools.ts",
  "src/server/mcp/tools/report-autopilot-tools.ts",
  "src/server/mcp/server.ts",
  "src/client/features/sam/SamAutopilotTab.tsx",
  "src/client/features/sam/samAutopilotQueries.ts",
  "src/client/features/sam/autopilotEvidence.ts",
  "src/client/features/sam/SamChat.tsx",
];

export const AUTOPILOT_LOCK_FILES = [
  "src/server/features/autopilot/repositories/AutopilotRepository.ts",
  "src/server/features/autopilot/services/autopilotTypes.ts",
  "src/server/features/autopilot/services/autopilotBudgets.ts",
  "src/server/features/autopilot/services/stepSupport.ts",
  "src/server/features/autopilot/services/stepExecutor.ts",
  "src/server/features/autopilot/services/synthesisFirewall.ts",
  "src/server/features/autopilot/services/autopilotSerializer.ts",
  "src/server/features/autopilot/services/autopilotWorkflowContent.ts",
  "src/server/features/autopilot/services/autopilotWorkflows.ts",
  "src/server/features/autopilot/services/AutopilotService.ts",
  "src/server/workflows/AutopilotWorkflow.ts",
  "src/serverFunctions/autopilot.ts",
  "src/types/schemas/autopilot.ts",
  "src/db/autopilot.schema.ts",
  "src/db/pg/autopilot.schema.ts",
  "drizzle/0058_glorious_terror.sql",
  "drizzle/0059_faithful_bulldozer.sql",
  "drizzle-pg/0036_giant_piledriver.sql",
  "drizzle-pg/0037_flashy_gressill.sql",
];
