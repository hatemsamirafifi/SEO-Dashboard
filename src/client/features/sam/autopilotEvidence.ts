import {
  isAutopilotRunActive,
  type AutopilotAttemptStatus,
  type AutopilotRunStatus,
  type AutopilotStepKind,
  type AutopilotStepStatus,
  type AutopilotWorkflowType,
} from "@/shared/autopilot";

// Pure autopilot-run readers for the SAM Autopilot tab (final-plan §13/§17).
// Frozen step evidence is parsed here so the component stays declarative and
// these readers stay unit-testable. Wording stays observational.
//
// Trust note: autopilot step evidence is same-trust-tier persisted data. The
// only writers are our internal step runners (stepSupport runCollectStep /
// runSimpleStep serialize the workflow's own deterministic builders, and
// reuseInvariantStep copies a prior completed row verbatim). No external,
// legacy-import, or manual-mutation path writes this column: workflow defs
// build evidence from engine rows + deterministic helpers, and the MCP/server
// surfaces never accept caller-supplied evidenceJson. The guarded parse below
// therefore tolerates corrupt historical rows (returns {} / skips) rather than
// treating this column as an external trust boundary requiring Zod.

export type AutopilotStepLike = {
  seq: number;
  kind: AutopilotStepKind | string;
  name: string;
  status: AutopilotStepStatus | string;
  evidenceJson: string | null;
};

export type AutopilotAttemptLike = {
  id: string;
  attemptNumber: number;
  status: AutopilotAttemptStatus | string;
  invalidationReason: string | null;
};

export type AutopilotRunLike = {
  id: string;
  workflowType: AutopilotWorkflowType | string;
  status: AutopilotRunStatus | string;
  evidenceHash: string | null;
};

export type RecommendationCard = {
  key: string;
  suggestedAction: string;
  reasoningSummary: string;
  confidenceValue: number | null;
  confidenceWhy: string;
  dataSource: string;
};

export function parseStepEvidence(
  evidenceJson: string | null,
): Record<string, unknown> {
  if (!evidenceJson) return {};
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(evidenceJson) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value: unknown = record[key];
  return typeof value === "string" ? value : "";
}

function confidenceOf(record: Record<string, unknown>): {
  value: number | null;
  why: string;
} {
  const raw: unknown = record["confidence"];
  if (!isRecord(raw)) return { value: null, why: "" };
  const value: unknown = raw["value"];
  const why: unknown = raw["why"];
  return {
    value: typeof value === "number" ? value : null,
    why: typeof why === "string" ? why : "",
  };
}

/** Recommendations from synthesize-step evidence, newest step first. */
export function recommendationCards(
  steps: AutopilotStepLike[],
): RecommendationCard[] {
  const ordered = [...steps].toSorted((a, b) => b.seq - a.seq);
  const cards: RecommendationCard[] = [];
  for (const step of ordered) {
    const record = parseStepEvidence(step.evidenceJson);
    const raw: unknown = record["recommendations"];
    if (!Array.isArray(raw)) continue;
    const items = raw.filter(isRecord);
    for (const [index, item] of items.entries()) {
      const confidence = confidenceOf(item);
      cards.push({
        key: `${step.seq}:${index}`,
        suggestedAction: stringField(item, "suggestedAction"),
        reasoningSummary: stringField(item, "reasoningSummary"),
        confidenceValue: confidence.value,
        confidenceWhy: confidence.why,
        dataSource: stringField(item, "dataSource"),
      });
    }
  }
  return cards;
}

/** Correlation rows from traffic-drop synthesize evidence, if present. */
export function correlationRows(
  steps: AutopilotStepLike[],
): Array<{ entity: string; agreement: string; signals: number }> {
  for (const step of [...steps].toSorted((a, b) => b.seq - a.seq)) {
    const record = parseStepEvidence(step.evidenceJson);
    const raw: unknown = record["correlationTable"];
    if (!Array.isArray(raw)) continue;
    return raw.filter(isRecord).map((row) => {
      const ids: unknown = row["opportunityIds"];
      return {
        entity: stringField(row, "entity"),
        agreement: stringField(row, "agreement"),
        signals: Array.isArray(ids) ? ids.length : 0,
      };
    });
  }
  return [];
}

export function attemptNote(attempt: AutopilotAttemptLike): string {
  if (attempt.status === "invalidated") {
    return `Attempt ${attempt.attemptNumber} set aside (sources changed mid-collection; a fresh attempt continued).`;
  }
  return `Attempt ${attempt.attemptNumber}: ${attempt.status}.`;
}

export function shouldPollRun(status: AutopilotRunStatus): boolean {
  return isAutopilotRunActive(status);
}

export const AUTOPILOT_RUN_STATUS_LABELS: Record<AutopilotRunStatus, string> =
  {
    pending: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };

export function runStatusLabel(status: AutopilotRunStatus): string {
  return AUTOPILOT_RUN_STATUS_LABELS[status];
}

export type TechnicalFacts = {
  coverageState: string;
  rankedIssues: { severity: string; type: string; count: number }[];
};

/** Facts block from technical-SEO synthesize evidence (P27: facts apart). */
export function technicalFacts(
  steps: AutopilotStepLike[],
): TechnicalFacts | null {
  for (const step of [...steps].toSorted((a, b) => b.seq - a.seq)) {
    const record = parseStepEvidence(step.evidenceJson);
    const facts: unknown = record["facts"];
    if (!isRecord(facts)) continue;
    const coverage: unknown = facts["auditCoverage"];
    if (!isRecord(coverage)) continue;
    const state: unknown = coverage["state"];
    if (typeof state !== "string") continue;
    const rawIssues: unknown = facts["rankedIssues"];
    const rankedIssues = Array.isArray(rawIssues)
      ? rawIssues.filter(isRecord).map((row) => ({
          severity: stringField(row, "severity"),
          type: stringField(row, "type"),
          count:
            typeof row["count"] === "number" ? row["count"] : 0,
        }))
      : [];
    return { coverageState: state, rankedIssues };
  }
  return null;
}

export type MonthlyChangedRow = {
  source: string;
  metric: string;
  monthValue: number | null;
  priorValue: number | null;
  delta: number | null;
  agreement: string;
};

export type MonthlySummary = {
  changed: MonthlyChangedRow[];
  ratios: { metric: string; monthValue: number | null; priorValue: number | null }[];
  unavailable: { source: string; reason: string }[];
  unresolved: { kind: string; label: string; title: string }[];
  nextActionCount: number;
};

function nullableNumberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value: unknown = record[key];
  return typeof value === "number" ? value : null;
}

/** Monthly-review sections from synthesize evidence (changed/unresolved/actions). */
export function monthlySummary(
  steps: AutopilotStepLike[],
): MonthlySummary | null {
  for (const step of [...steps].toSorted((a, b) => b.seq - a.seq)) {
    const record = parseStepEvidence(step.evidenceJson);
    const summary: unknown = record["summary"];
    if (!isRecord(summary)) continue;
    const rawChanged: unknown = summary["changed"];
    const rawRatios: unknown = summary["ratios"];
    const rawUnavailable: unknown = summary["unavailable"];
    const rawUnresolved: unknown = summary["unresolved"];
    const rawActions: unknown = summary["nextActions"];
    if (
      !Array.isArray(rawChanged) ||
      !Array.isArray(rawRatios) ||
      !Array.isArray(rawUnavailable) ||
      !Array.isArray(rawUnresolved) ||
      !Array.isArray(rawActions)
    ) {
      continue;
    }
    return {
      changed: rawChanged.filter(isRecord).map((row) => ({
        source: stringField(row, "source"),
        metric: stringField(row, "metric"),
        monthValue: nullableNumberField(row, "monthValue"),
        priorValue: nullableNumberField(row, "priorValue"),
        delta: nullableNumberField(row, "delta"),
        agreement: stringField(row, "agreement"),
      })),
      ratios: rawRatios.filter(isRecord).map((row) => ({
        metric: stringField(row, "metric"),
        monthValue: nullableNumberField(row, "monthValue"),
        priorValue: nullableNumberField(row, "priorValue"),
      })),
      unavailable: rawUnavailable.filter(isRecord).map((row) => ({
        source: stringField(row, "source"),
        reason: stringField(row, "reason"),
      })),
      unresolved: rawUnresolved.filter(isRecord).map((row) => ({
        kind: stringField(row, "kind"),
        label: stringField(row, "label"),
        title: stringField(row, "title"),
      })),
      nextActionCount: rawActions.filter(isRecord).length,
    };
  }
  return null;
}
