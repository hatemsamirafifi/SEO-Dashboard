import { InsightRepository } from "@/server/features/intelligence/repositories/InsightRepository";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
import {
  getAutopilotWorkflow,
  registerAutopilotWorkflow,
  type AutopilotWorkflowDef,
} from "./autopilotTypes";
import { serializeRecommendations } from "./autopilotSerializer";
import {
  buildCorrelationTable,
  correlationRowsOf,
  growthRecommendations,
  isPriority,
  priorCollect,
  rankedIds,
  rankedIdsOf,
  trafficRecommendations,
  type CollectedInsight,
  type CollectedOpportunity,
} from "./autopilotWorkflowContent";

export type { AutopilotWorkflowType } from "./autopilotWorkflowContent";
export {
  AUTOPILOT_WORKFLOW_TYPES,
  WORKFLOW_PROMPTS,
} from "./autopilotWorkflowContent";

// Workflow DEFINITIONS 1–3 (final-plan §13). Deterministic-first: collect
// reads ledger-level engine output, correlate computes overlaps, synthesize
// formats frozen evidence with observational phrasing only.

async function collectEngineState(projectId: string): Promise<{
  opportunities: CollectedOpportunity[];
  insights: CollectedInsight[];
}> {
  const [opportunities, insights] = await Promise.all([
    OpportunityRepository.listActiveByProject(projectId),
    InsightRepository.listUnresolvedByProject(projectId),
  ]);
  return {
    opportunities: opportunities.flatMap((row) => {
      if (!isPriority(row.priority)) return [];
      return [
        {
          id: row.id,
          logicalKey: row.logicalKey,
          type: row.type,
          priority: row.priority,
          impactScore: row.impactScore,
          confidenceScore: row.confidenceScore,
          title: row.title,
          page: row.page,
          keyword: row.keyword,
          lastDetectedAt: row.lastDetectedAt,
        },
      ];
    }),
    insights: insights.map((row) => ({
      insightKey: row.insightKey,
      severity: row.severity,
      title: row.title,
    })),
  };
}

function growthPlanDef(): AutopilotWorkflowDef {
  return {
    type: "growth_plan",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-priorities",
        run: async (ctx) => ({
          evidence: {
            ...(await collectEngineState(ctx.projectId)),
            collectedAt: new Date().toISOString(),
          },
        }),
      },
      {
        seq: 1,
        kind: "correlate",
        name: "rank-candidates",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          return {
            evidence: {
              rankedIds: rankedIds(opportunities, 10),
              totalConsidered: opportunities.length,
            },
          };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-growth-plan",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const ids = rankedIdsOf(ctx.priorEvidence[1]?.evidence);
          return {
            evidence: {
              recommendations: serializeRecommendations(
                growthRecommendations(opportunities, ids),
              ),
              evidenceType: "observational",
              promptVersion: 1,
            },
            toolCalls: 1,
          };
        },
      },
    ],
  };
}

function quickWinsDef(): AutopilotWorkflowDef {
  return {
    type: "quick_wins",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-quick-wins",
        run: async (ctx) => ({
          evidence: {
            ...(await collectEngineState(ctx.projectId)),
            collectedAt: new Date().toISOString(),
          },
        }),
      },
      {
        seq: 1,
        kind: "correlate",
        name: "filter-quick-wins",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const eligible = opportunities.filter(
            (row) => row.priority === "Critical" || row.priority === "High",
          );
          return {
            evidence: {
              rankedIds: rankedIds(eligible, 5),
              totalConsidered: eligible.length,
            },
          };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-quick-wins",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const ids = rankedIdsOf(ctx.priorEvidence[1]?.evidence);
          return {
            evidence: {
              recommendations: serializeRecommendations(
                growthRecommendations(opportunities, ids),
              ),
              evidenceType: "observational",
              promptVersion: 1,
            },
            toolCalls: 1,
          };
        },
      },
    ],
  };
}

function trafficDropDef(): AutopilotWorkflowDef {
  return {
    type: "traffic_drop",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-traffic-signals",
        run: async (ctx) => ({
          evidence: {
            ...(await collectEngineState(ctx.projectId)),
            collectedAt: new Date().toISOString(),
          },
        }),
      },
      {
        seq: 1,
        kind: "correlate",
        name: "build-correlation-table",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          return { evidence: { rows: buildCorrelationTable(opportunities) } };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-traffic-drop",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const rows = correlationRowsOf(ctx.priorEvidence[1]?.evidence);
          return {
            evidence: {
              recommendations: serializeRecommendations(
                trafficRecommendations(opportunities, rows),
              ),
              evidenceType: "observational",
              correlationTable: rows,
              promptVersion: 1,
            },
            toolCalls: 1,
          };
        },
      },
    ],
  };
}

export function ensureAutopilotWorkflowsRegistered(): void {
  const defs = [growthPlanDef(), quickWinsDef(), trafficDropDef()];
  for (const def of defs) {
    if (!getAutopilotWorkflow(def.type)) {
      registerAutopilotWorkflow(def);
    }
  }
}

ensureAutopilotWorkflowsRegistered();
