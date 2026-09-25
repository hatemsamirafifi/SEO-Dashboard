import { compareOpportunities } from "@/shared/intelligence";
import type { AutopilotStepContext } from "./autopilotTypes";

// Pure workflow content (final-plan §13): prompts, frozen-evidence guards,
// deterministic correlate helpers, and observational recommendation
// builders. No repository imports here — collection lives in
// autopilotWorkflows.ts so this module stays a pure function surface.

export const AUTOPILOT_WORKFLOW_TYPES = [
  "growth_plan",
  "quick_wins",
  "traffic_drop",
] as const;
export type AutopilotWorkflowType = (typeof AUTOPILOT_WORKFLOW_TYPES)[number];

export const WORKFLOW_PROMPTS: Record<AutopilotWorkflowType, string> = {
  growth_plan:
    "Build a growth plan from ranked engine output. Use only the frozen " +
    "evidence provided. Rank by stored priority, then impact, then " +
    "confidence. Describe each move with metrics and periods. Prefer " +
    "phrasing such as 'decreased during the same period' and 'consistent " +
    "with'. Keep confidence separate from impact. Never state a precise " +
    "uplift without a basis in the evidence.",
  quick_wins:
    "Surface quick wins from Critical and High opportunities only. Keep " +
    "each item small and reversible. Cite metrics and periods from the " +
    "frozen evidence. Use observational wording such as 'observed " +
    "alongside' and 'coincided with'. Leave lower-priority items out.",
  traffic_drop:
    "Explain a traffic drop from the correlation table only. Compare GSC " +
    "and GA4 windows side by side. Note agreement as overlap, never as " +
    "proof. Use wording such as 'decreased during the same period' and " +
    "'consistent with'. Mark single-source rows as provisional.",
};

export type CollectedOpportunity = {
  id: string;
  logicalKey: string;
  type: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  impactScore: number;
  confidenceScore: number;
  title: string;
  page: string | null;
  keyword: string | null;
  lastDetectedAt: string;
};

export type CollectedInsight = {
  insightKey: string;
  severity: string;
  title: string;
};

export type CorrelationRow = {
  entity: string;
  opportunityIds: string[];
  agreement: "corroborated" | "single_source";
};

export function isPriority(
  value: unknown,
): value is CollectedOpportunity["priority"] {
  return (
    value === "Critical" ||
    value === "High" ||
    value === "Medium" ||
    value === "Low"
  );
}

export function isCollectedOpportunity(
  value: unknown,
): value is CollectedOpportunity {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("id" in value) ||
    !("logicalKey" in value) ||
    !("type" in value) ||
    !("priority" in value)
  ) {
    return false;
  }
  const record: Record<string, unknown> = {
    id: value.id,
    logicalKey: value.logicalKey,
    type: value.type,
    priority: value.priority,
  };
  return (
    typeof record["id"] === "string" &&
    typeof record["logicalKey"] === "string" &&
    typeof record["type"] === "string" &&
    isPriority(record["priority"])
  );
}

export function isCollectedInsight(value: unknown): value is CollectedInsight {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("insightKey" in value) ||
    !("severity" in value) ||
    !("title" in value)
  ) {
    return false;
  }
  const record: Record<string, unknown> = {
    insightKey: value.insightKey,
    severity: value.severity,
    title: value.title,
  };
  return (
    typeof record["insightKey"] === "string" &&
    typeof record["severity"] === "string" &&
    typeof record["title"] === "string"
  );
}

export function priorCollect(ctx: AutopilotStepContext): {
  opportunities: CollectedOpportunity[];
  insights: CollectedInsight[];
} {
  const first: unknown = ctx.priorEvidence[0]?.evidence;
  if (typeof first !== "object" || first === null) {
    return { opportunities: [], insights: [] };
  }
  let rawOpportunities: unknown = [];
  let rawInsights: unknown = [];
  if ("opportunities" in first) rawOpportunities = first.opportunities;
  if ("insights" in first) rawInsights = first.insights;
  const opportunities: CollectedOpportunity[] = Array.isArray(rawOpportunities)
    ? (rawOpportunities as unknown[]).filter(isCollectedOpportunity)
    : [];
  const insights: CollectedInsight[] = Array.isArray(rawInsights)
    ? (rawInsights as unknown[]).filter(isCollectedInsight)
    : [];
  return { opportunities, insights };
}

export function rankedIds(
  opportunities: CollectedOpportunity[],
  limit: number,
): string[] {
  return [...opportunities]
    .toSorted(compareOpportunities)
    .slice(0, limit)
    .map((row) => row.id);
}

export function rankedIdsOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (!("rankedIds" in value)) return [];
  const raw: unknown = value.rankedIds;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
}

function isCorrelationRow(value: unknown): value is CorrelationRow {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("entity" in value) ||
    !("opportunityIds" in value) ||
    !("agreement" in value)
  ) {
    return false;
  }
  const record: Record<string, unknown> = {
    entity: value.entity,
    opportunityIds: value.opportunityIds,
    agreement: value.agreement,
  };
  if (typeof record["entity"] !== "string") return false;
  if (!Array.isArray(record["opportunityIds"])) return false;
  const ids = (record["opportunityIds"] as unknown[]).filter(
    (id: unknown): id is string => typeof id === "string",
  );
  if (ids.length !== (record["opportunityIds"] as unknown[]).length) {
    return ids.length > 0;
  }
  return (
    record["agreement"] === "corroborated" ||
    record["agreement"] === "single_source"
  );
}

export function correlationRowsOf(value: unknown): CorrelationRow[] {
  if (typeof value !== "object" || value === null) return [];
  if (!("rows" in value)) return [];
  const raw: unknown = value.rows;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(isCorrelationRow);
}

const TRAFFIC_TYPES = new Set([
  "organic_traffic_change",
  "ga4_organic_change",
  "content_decay",
  "ranking_drop",
]);

export function buildCorrelationTable(
  opportunities: CollectedOpportunity[],
): CorrelationRow[] {
  const traffic = opportunities.filter((row) => TRAFFIC_TYPES.has(row.type));
  const byEntity = new Map<string, string[]>();
  for (const row of traffic) {
    const entity = row.page ?? row.keyword ?? row.logicalKey;
    const ids = byEntity.get(entity) ?? [];
    ids.push(row.id);
    byEntity.set(entity, ids);
  }
  return [...byEntity.entries()].map(([entity, opportunityIds]) => ({
    entity,
    opportunityIds: [...opportunityIds].toSorted(),
    agreement: opportunityIds.length >= 2 ? "corroborated" : "single_source",
  }));
}

function opportunityById(
  opportunities: CollectedOpportunity[],
  id: string,
): CollectedOpportunity | null {
  return opportunities.find((row) => row.id === id) ?? null;
}

export function growthRecommendations(
  opportunities: CollectedOpportunity[],
  ids: string[],
): Record<string, unknown>[] {
  return ids.flatMap((id) => {
    const row = opportunityById(opportunities, id);
    if (!row) return [];
    return [
      {
        evidence: {
          metrics: `impact ${row.impactScore}, confidence ${row.confidenceScore}`,
          periods: `last seen ${row.lastDetectedAt}`,
        },
        dataSource: `opportunity:${row.logicalKey}`,
        reasoningSummary:
          `${row.title} is ranked ${row.priority} with impact ` +
          `${row.impactScore} observed during the same period as the latest scan`,
        confidence: {
          value: row.confidenceScore,
          why: `stored confidence ${row.confidenceScore} from engine evidence`,
        },
        expectedImpact: {
          kind: "qualitative",
          explanation:
            "Scope matches a top-ranked engine item; precise uplift needs a baseline comparison",
        },
        suggestedAction: `Review ${row.title} and apply the stored recommendation`,
        evidenceType: "observational",
      },
    ];
  });
}

export function trafficRecommendations(
  opportunities: CollectedOpportunity[],
  rows: CorrelationRow[],
): Record<string, unknown>[] {
  return rows.flatMap((row) => {
    const first = opportunityById(opportunities, row.opportunityIds[0] ?? "");
    const scope =
      row.agreement === "corroborated"
        ? "seen across more than one signal, consistent with a shared move"
        : "seen in a single signal so far; treat as provisional";
    return [
      {
        evidence: {
          metrics: `${row.opportunityIds.length} overlapping signals`,
          periods: "current window versus the previous equivalent window",
        },
        dataSource: row.opportunityIds
          .map((id) => `opportunity:${id}`)
          .join(","),
        reasoningSummary:
          `${row.entity} decreased during the same period as the overlapping ` +
          `signals (${scope})` +
          (first ? `, with headline '${first.title}'` : ""),
        confidence: {
          value: row.agreement === "corroborated" ? 65 : 40,
          why:
            row.agreement === "corroborated"
              ? "overlap across signals raises confidence without proving a link"
              : "single-source overlap stays provisional until a second signal confirms",
        },
        expectedImpact: {
          kind: "qualitative",
          explanation:
            "Direction is clear from overlap; sizing needs a stable baseline",
        },
        suggestedAction: `Inspect ${row.entity} in analytics and compare the same windows`,
        evidenceType: "observational",
      },
    ];
  });
}
