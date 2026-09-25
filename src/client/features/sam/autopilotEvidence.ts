import { isAutopilotRunActive } from "@/shared/autopilot";

// Pure autopilot-run readers for the SAM Autopilot tab (final-plan §13/§17).
// Frozen step evidence is parsed here so the component stays declarative and
// these readers stay unit-testable. Wording stays observational.

export type AutopilotStepLike = {
  seq: number;
  kind: string;
  name: string;
  status: string;
  evidenceJson: string | null;
};

export type AutopilotAttemptLike = {
  id: string;
  attemptNumber: number;
  status: string;
  invalidationReason: string | null;
};

export type AutopilotRunLike = {
  id: string;
  workflowType: string;
  status: string;
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

export function shouldPollRun(status: string): boolean {
  return isAutopilotRunActive(status);
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}
