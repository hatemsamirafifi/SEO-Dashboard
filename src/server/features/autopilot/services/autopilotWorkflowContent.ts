/* eslint-disable max-lines */
import type { AutopilotWorkflowType } from "@/shared/autopilot";
import { compareOpportunities } from "@/shared/intelligence";
import type { AutopilotStepContext } from "./autopilotTypes";

// Pure workflow content (final-plan §13): prompts, frozen-evidence guards,
// deterministic correlate helpers, and observational recommendation
// builders. No repository imports here — collection lives in
// autopilotWorkflows.ts so this module stays a pure function surface.

export {
  AUTOPILOT_WORKFLOW_TYPES,
  type AutopilotWorkflowType,
} from "@/shared/autopilot";

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
  content_refresh:
    "Refresh pages from ranked stored engine output. Use only the frozen " +
    "evidence provided. Rank by stored priority, then impact, then " +
    "confidence. Describe each candidate with metrics and periods from " +
    "the evidence. Prefer phrasing such as 'decreased during the same " +
    "period' and 'consistent with'. Keep confidence separate from impact. " +
    "Never state a precise uplift without a basis in the evidence. Pages " +
    "without stored evidence stay out of the plan.",
  technical_seo:
    "Plan technical fixes from the latest stored audit only. Use only the " +
    "frozen evidence provided. Rank issues by stored severity, then " +
    "affected-page count. Describe each item with counts and the audit " +
    "state from the evidence. Prefer phrasing such as 'observed in the " +
    "latest stored audit' and 'consistent with'. When audit coverage is " +
    "missing or stale, say so plainly and recommend running an audit " +
    "first — never present an empty plan as having no issues. Keep " +
    "confidence separate from impact. Never state a precise uplift " +
    "without a basis in the evidence.",
  monthly_review:
    "Review the previous complete month against the month before it from " +
    "frozen stored evidence only. Report what changed with metrics and " +
    "windows cited from the evidence. Mark single-source findings as " +
    "provisional. Use wording such as 'decreased during the same period' " +
    "and 'consistent with'. Keep confidence separate from impact. Never " +
    "state a precise uplift without a basis in the evidence. Missing data " +
    "stays visible as unavailable — never as zero.",
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

export function refreshRecommendations(
  opportunities: CollectedOpportunity[],
  ids: string[],
): Record<string, unknown>[] {
  return ids.flatMap((id) => {
    const row = opportunityById(opportunities, id);
    if (!row || !row.page) return [];
    return [
      {
        evidence: {
          metrics: `impact ${row.impactScore}, confidence ${row.confidenceScore}`,
          periods: `last seen ${row.lastDetectedAt}`,
        },
        dataSource: `opportunity:${row.logicalKey}`,
        reasoningSummary:
          `${row.page} is ranked ${row.priority} for refresh with impact ` +
          `${row.impactScore} observed during the same period as the latest scan`,
        confidence: {
          value: row.confidenceScore,
          why: `stored confidence ${row.confidenceScore} from engine evidence`,
        },
        expectedImpact: {
          kind: "qualitative",
          explanation:
            "Candidate matches a top-ranked stored item; precise uplift needs a baseline comparison",
        },
        suggestedAction: `Review ${row.page} for a content refresh and compare the same windows afterward`,
        evidenceType: "observational",
      },
    ];
  });
}

export type AuditCoverage =
  | { state: "never_run" }
  | { state: "stale_or_failed"; auditStatus: string }
  | { state: "empty_crawl" }
  | {
      state: "ready";
      auditId: string;
      pagesCrawled: number;
      completedAt: string | null;
    };

export function auditCoverageOf(
  latest: {
    id: string;
    status: string;
    pagesCrawled: number;
    completedAt: string | null;
  } | null
    | undefined,
): AuditCoverage {
  if (!latest) return { state: "never_run" };
  if (latest.status !== "completed") {
    return { state: "stale_or_failed", auditStatus: latest.status };
  }
  if (latest.pagesCrawled === 0) return { state: "empty_crawl" };
  return {
    state: "ready",
    auditId: latest.id,
    pagesCrawled: latest.pagesCrawled,
    completedAt: latest.completedAt,
  };
}

export type RankedIssue = {
  severity: string;
  type: string;
  count: number;
};

const AUDIT_SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function rankIssues(
  rows: { issueType: string; severity: string; pages: number }[],
): RankedIssue[] {
  return rows
    .map((row) => ({
      severity: row.severity,
      type: row.issueType,
      count: row.pages,
    }))
    .toSorted(
      (a, b) =>
        (AUDIT_SEVERITY_RANK[a.severity] ?? 3) -
          (AUDIT_SEVERITY_RANK[b.severity] ?? 3) || b.count - a.count,
    )
    .slice(0, 10);
}

export const TECHNICAL_TYPES = new Set(["technical_on_important_page"]);

function insufficientCoverageRecommendation(
  coverage: Exclude<AuditCoverage, { state: "ready" }>,
): Record<string, unknown> {
  const detail =
    coverage.state === "never_run"
      ? "no site audit has ever completed for this project"
      : coverage.state === "empty_crawl"
        ? "the latest stored audit crawled zero pages"
        : `the latest stored audit is ${coverage.auditStatus}`;
  return {
    evidence: {
      metrics: `audit coverage state: ${coverage.state}`,
      periods: "latest stored state",
    },
    dataSource: "audit:coverage",
    reasoningSummary:
      `${detail}, consistent with missing or stale audit evidence — ` +
      "no technical plan can be built from stored evidence yet",
    confidence: {
      value: 80,
      why: "audit absence is directly observed in stored state",
    },
    expectedImpact: {
      kind: "qualitative",
      explanation: "No sizing possible without audit evidence",
    },
    suggestedAction:
      "Run a site audit for this project first, then re-run the technical SEO workflow",
    evidenceType: "observational",
  };
}

export function technicalRecommendations(
  coverage: AuditCoverage,
  rankedIssues: RankedIssue[],
  opportunities: CollectedOpportunity[],
  rankedOpportunityIds: string[],
): Record<string, unknown>[] {
  if (coverage.state !== "ready") {
    return [insufficientCoverageRecommendation(coverage)];
  }
  const issueRecommendations = rankedIssues.map((issue) => ({
    evidence: {
      metrics: `${issue.count} pages affected`,
      periods: "latest stored audit",
    },
    dataSource: `audit:${coverage.auditId}:${issue.type}`,
    reasoningSummary:
      `${issue.count} pages show ${issue.type} (severity ${issue.severity}) ` +
      "in the latest stored audit, consistent with a technical backlog",
    confidence: {
      value:
        issue.severity === "critical"
          ? 70
          : issue.severity === "warning"
            ? 55
            : 40,
      why: `stored severity ${issue.severity} from the latest audit`,
    },
    expectedImpact: {
      kind: "qualitative",
      explanation:
        "Scope matches stored audit evidence; precise uplift needs a baseline comparison",
    },
    suggestedAction: `Inspect ${issue.type} findings in the audit report and fix the affected pages`,
    evidenceType: "observational",
  }));
  const opportunityRecommendations = rankedOpportunityIds.flatMap((id) => {
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
            "Scope matches a top-ranked stored technical item; precise uplift needs a baseline comparison",
        },
        suggestedAction: `Review ${row.title} and apply the stored technical recommendation`,
        evidenceType: "observational",
      },
    ];
  });
  return [...issueRecommendations, ...opportunityRecommendations];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAuditCoverage(value: unknown): value is AuditCoverage {
  if (!isRecord(value)) return false;
  const state: unknown = value["state"];
  if (state === "never_run" || state === "empty_crawl") return true;
  if (state === "stale_or_failed") {
    return typeof value["auditStatus"] === "string";
  }
  if (state === "ready") {
    return (
      typeof value["auditId"] === "string" &&
      typeof value["pagesCrawled"] === "number" &&
      (typeof value["completedAt"] === "string" ||
        value["completedAt"] === null)
    );
  }
  return false;
}

function isIssueCount(value: unknown): value is {
  issueType: string;
  severity: string;
  pages: number;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value["issueType"] === "string" &&
    typeof value["severity"] === "string" &&
    typeof value["pages"] === "number"
  );
}

export function technicalCollectOf(evidence: unknown): {
  coverage: AuditCoverage;
  issueCounts: { issueType: string; severity: string; pages: number }[];
} {
  if (!isRecord(evidence)) {
    throw new Error("technical_seo collect evidence is missing");
  }
  const coverage: unknown = evidence["auditCoverage"];
  if (!isAuditCoverage(coverage)) {
    throw new Error("technical_seo collect evidence carries no coverage");
  }
  const raw: unknown = evidence["issues"];
  return {
    coverage,
    issueCounts: Array.isArray(raw) ? raw.filter(isIssueCount) : [],
  };
}

function isRankedIssue(value: unknown): value is RankedIssue {
  if (!isRecord(value)) return false;
  return (
    typeof value["severity"] === "string" &&
    typeof value["type"] === "string" &&
    typeof value["count"] === "number"
  );
}

export function technicalCorrelateOf(evidence: unknown): {
  coverage: AuditCoverage;
  rankedIssues: RankedIssue[];
  rankedOpportunityIds: string[];
} {
  if (!isRecord(evidence)) {
    throw new Error("technical_seo correlate evidence is missing");
  }
  const coverage: unknown = evidence["auditCoverage"];
  if (!isAuditCoverage(coverage)) {
    throw new Error("technical_seo correlate evidence carries no coverage");
  }
  const rawIssues: unknown = evidence["rankedIssues"];
  return {
    coverage,
    rankedIssues: Array.isArray(rawIssues)
      ? rawIssues.filter(isRankedIssue)
      : [],
    rankedOpportunityIds: rankedIdsOf(evidence),
  };
}

export type MonthWindow = { from: string; to: string };

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function deriveMonthWindows(now: Date): {
  month: MonthWindow;
  prior: MonthWindow;
} {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  return {
    month: {
      from: isoDay(new Date(Date.UTC(year, monthIndex - 1, 1))),
      to: isoDay(new Date(Date.UTC(year, monthIndex, 0))),
    },
    prior: {
      from: isoDay(new Date(Date.UTC(year, monthIndex - 2, 1))),
      to: isoDay(new Date(Date.UTC(year, monthIndex - 1, 0))),
    },
  };
}

export type ChangedRow = {
  source: "gsc" | "ga4";
  metric: string;
  monthValue: number | null;
  priorValue: number | null;
  delta: number | null;
  agreement: "corroborated" | "single_source";
};

export type RatioRow = {
  metric: "ctr" | "position";
  monthValue: number | null;
  priorValue: number | null;
};

export type UnavailableRow = {
  source: string;
  reason: string;
};

type StatusEnvelope = { available: boolean; reason: string | null };

export type VisibilityEnvelope = {
  status: StatusEnvelope;
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  } | null;
};

export type TrafficMonthEnvelope = {
  traffic: {
    status: StatusEnvelope;
    totals: {
      sessions: number;
      screenPageViews: number;
      keyEvents: number;
      transactions: number;
    } | null;
  };
  conversions: {
    status: StatusEnvelope;
    keyEvents: number | null;
    transactions: number | null;
  };
};

function monthTotals<T>(envelope: {
  status: StatusEnvelope;
  totals: T | null;
} | null
  | undefined): T | null {
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.status?.available !== true) return null;
  return envelope.totals ?? null;
}

type DeltaSpec = {
  source: "gsc" | "ga4";
  metric: string;
  monthValue: number | null;
  priorValue: number | null;
};

function directionOf(delta: number): string {
  return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
}

export function buildChangedRows(input: {
  searchVisibility: { month: VisibilityEnvelope; prior: VisibilityEnvelope };
  traffic: { month: TrafficMonthEnvelope; prior: TrafficMonthEnvelope };
}): {
  changed: ChangedRow[];
  ratios: RatioRow[];
  unavailable: UnavailableRow[];
} {
  const svMonth = monthTotals(input.searchVisibility.month);
  const svPrior = monthTotals(input.searchVisibility.prior);
  const trafficMonth = monthTotals(input.traffic.month.traffic);
  const trafficPrior = monthTotals(input.traffic.prior.traffic);
  const conversionsMonth =
    input.traffic.month.conversions.status?.available === true
      ? input.traffic.month.conversions
      : null;
  const conversionsPrior =
    input.traffic.prior.conversions.status?.available === true
      ? input.traffic.prior.conversions
      : null;

  const specs: DeltaSpec[] = [
    {
      source: "gsc",
      metric: "clicks",
      monthValue: svMonth?.clicks ?? null,
      priorValue: svPrior?.clicks ?? null,
    },
    {
      source: "gsc",
      metric: "impressions",
      monthValue: svMonth?.impressions ?? null,
      priorValue: svPrior?.impressions ?? null,
    },
    {
      source: "ga4",
      metric: "sessions",
      monthValue: trafficMonth?.sessions ?? null,
      priorValue: trafficPrior?.sessions ?? null,
    },
    {
      source: "ga4",
      metric: "pageViews",
      monthValue: trafficMonth?.screenPageViews ?? null,
      priorValue: trafficPrior?.screenPageViews ?? null,
    },
    {
      source: "ga4",
      metric: "keyEvents",
      monthValue: conversionsMonth?.keyEvents ?? null,
      priorValue: conversionsPrior?.keyEvents ?? null,
    },
    {
      source: "ga4",
      metric: "transactions",
      monthValue: conversionsMonth?.transactions ?? null,
      priorValue: conversionsPrior?.transactions ?? null,
    },
  ];

  const changed: ChangedRow[] = [];
  const unavailable: UnavailableRow[] = [];
  const seenUnavailable = new Set<string>();
  const markUnavailable = (source: string, reason: string | null) => {
    if (seenUnavailable.has(source)) return;
    seenUnavailable.add(source);
    unavailable.push({ source, reason: reason ?? "unavailable" });
  };
  for (const spec of specs) {
    if (spec.monthValue === null || spec.priorValue === null) {
      markUnavailable(
        spec.source,
        spec.source === "gsc"
          ? (input.searchVisibility.month.totals === null
            ? input.searchVisibility.month.status.reason
            : input.searchVisibility.prior.status.reason)
          : "ga4 coverage incomplete for the compared windows",
      );
      continue;
    }
    changed.push({
      source: spec.source,
      metric: spec.metric,
      monthValue: spec.monthValue,
      priorValue: spec.priorValue,
      delta: spec.monthValue - spec.priorValue,
      agreement: "single_source",
    });
  }
  for (const row of changed) {
    if (row.delta === null) continue;
    const direction = directionOf(row.delta);
    row.agreement = changed.some(
      (other) =>
        other !== row &&
        other.delta !== null &&
        directionOf(other.delta) === direction,
    )
      ? "corroborated"
      : "single_source";
  }

  const ratios: RatioRow[] = [];
  if (svMonth && svPrior) {
    ratios.push(
      { metric: "ctr", monthValue: svMonth.ctr, priorValue: svPrior.ctr },
      {
        metric: "position",
        monthValue: svMonth.position,
        priorValue: svPrior.position,
      },
    );
  }
  return { changed, ratios, unavailable };
}

export type UnresolvedRow = {
  kind: "opportunity" | "insight";
  label: string;
  title: string;
  ref: string;
  impactScore: number | null;
  confidenceScore: number | null;
};

const REVIEW_PRIORITY_RANK: Record<string, number> = {
  Critical: 0,
  High: 1,
};

export function unresolvedReviewRows(
  opportunities: {
    status: string;
    priority: string;
    title: string;
    logicalKey: string;
    impactScore: number | null;
    confidenceScore: number | null;
  }[],
  insights: { insightKey: string; severity: string; title: string }[],
): UnresolvedRow[] {
  const open = opportunities
    .filter(
      (row) =>
        (row.status === "open" || row.status === "in_progress") &&
        (row.priority === "Critical" || row.priority === "High"),
    )
    .toSorted(
      (a, b) =>
        (REVIEW_PRIORITY_RANK[a.priority] ?? 2) -
          (REVIEW_PRIORITY_RANK[b.priority] ?? 2) ||
        (b.impactScore ?? 0) - (a.impactScore ?? 0) ||
        (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0) ||
        (a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0),
    )
    .map((row) => ({
      kind: "opportunity" as const,
      label: row.priority,
      title: row.title,
      ref: row.logicalKey,
      impactScore: row.impactScore,
      confidenceScore: row.confidenceScore,
    }));
  const openInsights = insights.map((row) => ({
    kind: "insight" as const,
    label: row.severity,
    title: row.title,
    ref: row.insightKey,
    impactScore: null,
    confidenceScore: null,
  }));
  return [...open, ...openInsights].slice(0, 10);
}

export function monthlyReviewRecommendations(
  unresolved: UnresolvedRow[],
  monthLabel: string,
): Record<string, unknown>[] {
  return unresolved.map((row) => {
    const confidence = row.confidenceScore ?? 50;
    return {
      evidence: {
        metrics: `priority ${row.label}`,
        periods: `review month ${monthLabel}`,
      },
      dataSource: `${row.kind}:${row.ref}`,
      reasoningSummary:
        `${row.title} remains ${row.label} and unresolved during ${monthLabel}, ` +
        "consistent with outstanding work from stored evidence",
      confidence: {
        value: confidence,
        why:
          row.confidenceScore !== null
            ? `stored confidence ${row.confidenceScore} from engine evidence`
            : "unresolved stored item; review-tier attention without engine scoring",
      },
      expectedImpact: {
        kind: "qualitative",
        explanation:
          "Scope matches a stored unresolved item; precise uplift needs a baseline comparison",
      },
      suggestedAction: `Review ${row.title} (${row.ref}) and act on the stored recommendation`,
      evidenceType: "observational",
    };
  });
}

function isNullableNumber(field: unknown): boolean {
  return typeof field === "number" || field === null;
}

function isMonthWindow(value: unknown): value is MonthWindow {
  if (!isRecord(value)) return false;
  return (
    typeof value["from"] === "string" && typeof value["to"] === "string"
  );
}

function isChangedRow(value: unknown): value is ChangedRow {
  if (!isRecord(value)) return false;
  return (
    typeof value["source"] === "string" &&
    typeof value["metric"] === "string" &&
    isNullableNumber(value["monthValue"]) &&
    isNullableNumber(value["priorValue"]) &&
    isNullableNumber(value["delta"]) &&
    (value["agreement"] === "corroborated" ||
      value["agreement"] === "single_source")
  );
}

function isRatioRow(value: unknown): value is RatioRow {
  if (!isRecord(value)) return false;
  return (
    (value["metric"] === "ctr" || value["metric"] === "position") &&
    isNullableNumber(value["monthValue"]) &&
    isNullableNumber(value["priorValue"])
  );
}

function isUnavailableRow(value: unknown): value is UnavailableRow {
  if (!isRecord(value)) return false;
  return (
    typeof value["source"] === "string" && typeof value["reason"] === "string"
  );
}

function isUnresolvedRow(value: unknown): value is UnresolvedRow {
  if (!isRecord(value)) return false;
  return (
    (value["kind"] === "opportunity" || value["kind"] === "insight") &&
    typeof value["label"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["ref"] === "string" &&
    isNullableNumber(value["impactScore"]) &&
    isNullableNumber(value["confidenceScore"])
  );
}

function recordList(
  record: Record<string, unknown>,
  key: string,
): unknown[] {
  const raw: unknown = record[key];
  return Array.isArray(raw) ? [...raw] : [];
}

export function monthlyCorrelateOf(evidence: unknown): {
  monthLabel: string;
  changed: ChangedRow[];
  ratios: RatioRow[];
  unavailable: UnavailableRow[];
  unresolved: UnresolvedRow[];
} {
  if (!isRecord(evidence)) {
    throw new Error("monthly_review correlate evidence is missing");
  }
  const month: unknown = evidence["month"];
  if (!isMonthWindow(month) || month.from.length < 7) {
    throw new Error("monthly_review correlate evidence carries no window");
  }
  return {
    monthLabel: month.from.slice(0, 7),
    changed: recordList(evidence, "changed").filter(isChangedRow),
    ratios: recordList(evidence, "ratios").filter(isRatioRow),
    unavailable: recordList(evidence, "unavailable").filter(isUnavailableRow),
    unresolved: recordList(evidence, "unresolved").filter(isUnresolvedRow),
  };
}

function isStatusEnvelope(value: unknown): value is StatusEnvelope {
  if (!isRecord(value)) return false;
  return (
    typeof value["available"] === "boolean" &&
    (typeof value["reason"] === "string" || value["reason"] === null)
  );
}

function isVisibilityEnvelope(value: unknown): value is VisibilityEnvelope {
  if (!isRecord(value)) return false;
  if (!isStatusEnvelope(value["status"])) return false;
  const totals: unknown = value["totals"];
  if (totals === null) return true;
  if (!isRecord(totals)) return false;
  return (
    typeof totals["clicks"] === "number" &&
    typeof totals["impressions"] === "number" &&
    typeof totals["ctr"] === "number" &&
    typeof totals["position"] === "number"
  );
}

function isTrafficMonthEnvelope(
  value: unknown,
): value is TrafficMonthEnvelope {
  if (!isRecord(value)) return false;
  const traffic: unknown = value["traffic"];
  const conversions: unknown = value["conversions"];
  if (!isRecord(traffic) || !isRecord(conversions)) return false;
  if (!isStatusEnvelope(traffic["status"])) return false;
  const totals: unknown = traffic["totals"];
  if (totals !== null) {
    if (!isRecord(totals)) return false;
    if (
      typeof totals["sessions"] !== "number" ||
      typeof totals["screenPageViews"] !== "number" ||
      typeof totals["keyEvents"] !== "number" ||
      typeof totals["transactions"] !== "number"
    ) {
      return false;
    }
  }
  if (!isStatusEnvelope(conversions["status"])) return false;
  return (
    isNullableNumber(conversions["keyEvents"]) &&
    isNullableNumber(conversions["transactions"])
  );
}

function isStoredOpportunity(value: unknown): value is {
  status: string;
  priority: string;
  title: string;
  logicalKey: string;
  impactScore: number | null;
  confidenceScore: number | null;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value["status"] === "string" &&
    typeof value["priority"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["logicalKey"] === "string" &&
    isNullableNumber(value["impactScore"]) &&
    isNullableNumber(value["confidenceScore"])
  );
}

function isStoredInsight(value: unknown): value is {
  insightKey: string;
  severity: string;
  title: string;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value["insightKey"] === "string" &&
    typeof value["severity"] === "string" &&
    typeof value["title"] === "string"
  );
}

export function monthlyCollectOf(evidence: unknown): {
  month: MonthWindow;
  prior: MonthWindow;
  searchVisibility: { month: VisibilityEnvelope; prior: VisibilityEnvelope };
  traffic: { month: TrafficMonthEnvelope; prior: TrafficMonthEnvelope };
  opportunities: {
    status: string;
    priority: string;
    title: string;
    logicalKey: string;
    impactScore: number | null;
    confidenceScore: number | null;
  }[];
  insights: { insightKey: string; severity: string; title: string }[];
} {
  if (!isRecord(evidence)) {
    throw new Error("monthly_review collect evidence is missing");
  }
  const month: unknown = evidence["month"];
  const prior: unknown = evidence["prior"];
  if (!isMonthWindow(month) || !isMonthWindow(prior)) {
    throw new Error("monthly_review collect evidence carries no window");
  }
  const searchVisibility: unknown = evidence["searchVisibility"];
  const trafficConversions: unknown = evidence["trafficConversions"];
  if (!isRecord(searchVisibility) || !isRecord(trafficConversions)) {
    throw new Error("monthly_review collect evidence carries no envelopes");
  }
  const svMonth: unknown = searchVisibility["month"];
  const svPrior: unknown = searchVisibility["prior"];
  const tcMonth: unknown = trafficConversions["month"];
  const tcPrior: unknown = trafficConversions["prior"];
  if (
    !isVisibilityEnvelope(svMonth) ||
    !isVisibilityEnvelope(svPrior) ||
    !isTrafficMonthEnvelope(tcMonth) ||
    !isTrafficMonthEnvelope(tcPrior)
  ) {
    throw new Error("monthly_review collect evidence carries bad envelopes");
  }
  const opportunities: unknown = evidence["opportunities"];
  const insights: unknown = evidence["insights"];
  if (!Array.isArray(opportunities) || !Array.isArray(insights)) {
    throw new Error("monthly_review collect evidence carries no engine state");
  }
  return {
    month,
    prior,
    searchVisibility: { month: svMonth, prior: svPrior },
    traffic: { month: tcMonth, prior: tcPrior },
    opportunities: opportunities.filter(isStoredOpportunity),
    insights: insights.filter(isStoredInsight),
  };
}
