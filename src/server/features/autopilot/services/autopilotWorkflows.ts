/* eslint-disable max-lines */
import { InsightRepository } from "@/server/features/intelligence/repositories/InsightRepository";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  collectInsights,
  collectOpportunities,
  collectOverviewParts,
  collectSearchVisibility,
  collectTrafficAndConversions,
} from "@/server/features/reports/services/reportSections";
import {
  getAutopilotWorkflow,
  registerAutopilotWorkflow,
  type AutopilotWorkflowDef,
} from "./autopilotTypes";
import { serializeRecommendations } from "./autopilotSerializer";
import {
  auditCoverageOf,
  buildChangedRows,
  buildCorrelationTable,
  correlationRowsOf,
  deriveMonthWindows,
  growthRecommendations,
  isPriority,
  monthlyCorrelateOf,
  monthlyCollectOf,
  monthlyReviewRecommendations,
  priorCollect,
  rankedIds,
  rankedIdsOf,
  rankIssues,
  refreshRecommendations,
  TECHNICAL_TYPES,
  technicalCollectOf,
  technicalCorrelateOf,
  technicalRecommendations,
  trafficRecommendations,
  unresolvedReviewRows,
  type AuditCoverage,
  type CollectedInsight,
  type CollectedOpportunity,
  type RankedIssue,
} from "./autopilotWorkflowContent";

export type { AutopilotWorkflowType } from "./autopilotWorkflowContent";
export {
  AUTOPILOT_WORKFLOW_TYPES,
  WORKFLOW_PROMPTS,
} from "./autopilotWorkflowContent";

// Workflow DEFINITIONS 1–3 (final-plan §13). Deterministic-first: collect
// reads ledger-level engine output, correlate computes overlaps, synthesize
// formats frozen evidence with observational phrasing only.

export async function collectEngineState(projectId: string): Promise<{
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
  const defs = [
    growthPlanDef(),
    quickWinsDef(),
    trafficDropDef(),
    contentRefreshDef(),
    technicalSeoDef(),
    monthlyReviewDef(),
  ];
  for (const def of defs) {
    if (!getAutopilotWorkflow(def.type)) {
      registerAutopilotWorkflow(def);
    }
  }
}

export async function collectAuditEvidence(projectId: string): Promise<{
  auditCoverage: AuditCoverage;
  issues: { issueType: string; severity: string; pages: number }[];
}> {
  const latest = await AuditRepository.getLatestAuditForProject(projectId);
  const auditCoverage = auditCoverageOf(
    latest
      ? {
          id: latest.id,
          status: latest.status,
          pagesCrawled: latest.pagesCrawled,
          completedAt: latest.completedAt,
        }
      : null,
  );
  if (auditCoverage.state !== "ready") {
    return { auditCoverage, issues: [] };
  }
  const issues = await getIssueTypePageCountsForAudit(auditCoverage.auditId);
  return { auditCoverage, issues };
}

function technicalSeoDef(): AutopilotWorkflowDef {
  return {
    type: "technical_seo",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-technical-state",
        run: async (ctx) => ({
          evidence: {
            ...(await collectAuditEvidence(ctx.projectId)),
            ...(await collectEngineState(ctx.projectId)),
            collectedAt: new Date().toISOString(),
          },
        }),
      },
      {
        seq: 1,
        kind: "correlate",
        name: "rank-technical-work",
        run: async (ctx) => {
          const { coverage, issueCounts } = technicalCollectOf(
            ctx.priorEvidence[0]?.evidence,
          );
          const { opportunities } = priorCollect(ctx);
          const technical = opportunities.filter((row) =>
            TECHNICAL_TYPES.has(row.type),
          );
          return {
            evidence: {
              auditCoverage: coverage,
              rankedIssues: rankIssues(issueCounts),
              rankedOpportunityIds: rankedIds(technical, 10),
            },
          };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-technical-seo",
        run: async (ctx) => {
          const { coverage, rankedIssues, rankedOpportunityIds } =
            technicalCorrelateOf(ctx.priorEvidence[1]?.evidence);
          const { opportunities } = priorCollect(ctx);
          const recommendations = technicalRecommendations(
            coverage,
            rankedIssues,
            opportunities,
            rankedOpportunityIds,
          );
          const facts =
            coverage.state === "ready"
              ? { auditCoverage: coverage, rankedIssues }
              : { auditCoverage: coverage, rankedIssues: [] as RankedIssue[] };
          return {
            evidence: {
              facts,
              recommendations: serializeRecommendations(recommendations),
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

function contentRefreshDef(): AutopilotWorkflowDef {
  return {
    type: "content_refresh",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-refresh-state",
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
        name: "rank-refresh-candidates",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const candidates = opportunities.filter((row) => row.page !== null);
          return {
            evidence: {
              rankedIds: rankedIds(candidates, 10),
              totalConsidered: candidates.length,
            },
          };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-content-refresh",
        run: async (ctx) => {
          const { opportunities } = priorCollect(ctx);
          const ids = rankedIdsOf(ctx.priorEvidence[1]?.evidence);
          return {
            evidence: {
              recommendations: serializeRecommendations(
                refreshRecommendations(opportunities, ids),
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

export async function collectMonthlyEvidence(input: {
  projectId: string;
  organizationId: string;
}): Promise<{
  month: { from: string; to: string };
  prior: { from: string; to: string };
  searchVisibility: {
    month: Awaited<ReturnType<typeof collectSearchVisibility>>;
    prior: Awaited<ReturnType<typeof collectSearchVisibility>>;
  };
  trafficConversions: {
    month: Awaited<ReturnType<typeof collectTrafficAndConversions>>;
    prior: Awaited<ReturnType<typeof collectTrafficAndConversions>>;
  };
  overviewParts: Awaited<ReturnType<typeof collectOverviewParts>>;
  opportunities: Awaited<ReturnType<typeof collectOpportunities>>;
  insights: Awaited<ReturnType<typeof collectInsights>>;
  collectedAt: string;
}> {
  const windows = deriveMonthWindows(new Date());
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.organizationId,
  );
  const domain = project?.domain ?? null;
  const [
    svMonth,
    svPrior,
    tcMonth,
    tcPrior,
    overviewParts,
    insights,
    opportunities,
  ] = await Promise.all([
    collectSearchVisibility(
      input.projectId,
      windows.month.from,
      windows.month.to,
    ),
    collectSearchVisibility(
      input.projectId,
      windows.prior.from,
      windows.prior.to,
    ),
    collectTrafficAndConversions(
      input.projectId,
      input.organizationId,
      windows.month.from,
      windows.month.to,
    ),
    collectTrafficAndConversions(
      input.projectId,
      input.organizationId,
      windows.prior.from,
      windows.prior.to,
    ),
    collectOverviewParts(input.projectId, domain),
    collectInsights(input.projectId),
    collectOpportunities(input.projectId),
  ]);
  return {
    month: windows.month,
    prior: windows.prior,
    searchVisibility: { month: svMonth, prior: svPrior },
    trafficConversions: { month: tcMonth, prior: tcPrior },
    overviewParts,
    opportunities,
    insights,
    collectedAt: new Date().toISOString(),
  };
}

function monthlyReviewDef(): AutopilotWorkflowDef {
  return {
    type: "monthly_review",
    steps: [
      {
        seq: 0,
        kind: "collect",
        name: "collect-monthly-evidence",
        run: async (ctx) => ({
          evidence: await collectMonthlyEvidence({
            projectId: ctx.projectId,
            organizationId: ctx.organizationId,
          }),
        }),
      },
      {
        seq: 1,
        kind: "correlate",
        name: "compare-month-windows",
        run: async (ctx) => {
          const collect = monthlyCollectOf(ctx.priorEvidence[0]?.evidence);
          const { changed, ratios, unavailable } = buildChangedRows({
            searchVisibility: collect.searchVisibility,
            traffic: collect.traffic,
          });
          return {
            evidence: {
              month: collect.month,
              prior: collect.prior,
              changed,
              ratios,
              unavailable,
              unresolved: unresolvedReviewRows(
                collect.opportunities,
                collect.insights,
              ),
            },
          };
        },
      },
      {
        seq: 2,
        kind: "synthesize",
        name: "synthesize-monthly-review",
        run: async (ctx) => {
          const { monthLabel, changed, ratios, unavailable, unresolved } =
            monthlyCorrelateOf(ctx.priorEvidence[1]?.evidence);
          return {
            evidence: {
              summary: {
                changed,
                ratios,
                unavailable,
                unresolved,
                nextActions: serializeRecommendations(
                  monthlyReviewRecommendations(unresolved, monthLabel),
                ),
              },
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

ensureAutopilotWorkflowsRegistered();
