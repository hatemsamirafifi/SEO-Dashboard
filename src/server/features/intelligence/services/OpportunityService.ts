import { waitUntil } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  OPPORTUNITY_WEIGHTS,
  type ImpactFactorName,
} from "@/shared/opportunity-weights";
import {
  PRIORITIES,
  compareOpportunities,
  renormalizedScore,
  stableHash,
  type OpportunityPriority,
  type ScoredFactor,
} from "@/shared/intelligence";
import {
  OpportunityRepository,
  type OpportunityRow,
  type OpportunityStatus,
} from "../repositories/OpportunityRepository";

/**
 * User-facing opportunity reads and status lifecycle (final-plan §10).
 * Detection writes flow through the materializer; this service owns only
 * explicit user transitions. Terminal rows are immutable here (recurrence
 * creates new occurrences on redetection, never reopens).
 */

function isPriority(value: string): value is OpportunityPriority {
  return (PRIORITIES as readonly string[]).includes(value);
}

function toComparable(row: OpportunityRow): {
  priority: OpportunityPriority;
  impactScore: number;
  confidenceScore: number;
  lastDetectedAt: string;
} {
  if (!isPriority(row.priority)) {
    throw new AppError("INTERNAL_ERROR", "Invalid stored priority");
  }
  return {
    priority: row.priority,
    impactScore: row.impactScore,
    confidenceScore: row.confidenceScore,
    lastDetectedAt: row.lastDetectedAt,
  };
}

export type ImpactBreakdownRow = {
  factor: ImpactFactorName;
  weight: number;
  value: number | null;
};

export type ImpactBreakdown = {
  rows: ImpactBreakdownRow[];
  /** Renormalized divisor (sum of available weights). */
  divisor: number;
  /** Recomputed score; null when no factor is available. */
  score: number | null;
};

export type OpportunityWithBreakdown = OpportunityRow & {
  impactBreakdown: ImpactBreakdown | null;
  confidenceInputs: Record<string, string | number | boolean> | null;
};

const IMPACT_FACTOR_NAMES = [
  "trafficPotential",
  "proximity",
  "decline",
  "businessIntent",
  "conversionSignal",
] as const;

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function factorField(obj: Record<string, unknown>, key: string): number | null {
  const value: unknown = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseFactors(
  json: string | null,
): Record<ImpactFactorName, number | null> | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isStringRecord(parsed)) return null;
  return {
    trafficPotential: factorField(parsed, "trafficPotential"),
    proximity: factorField(parsed, "proximity"),
    decline: factorField(parsed, "decline"),
    businessIntent: factorField(parsed, "businessIntent"),
    conversionSignal: factorField(parsed, "conversionSignal"),
  };
}

function parseStringRecord(
  json: string | null,
): Record<string, string | number | boolean> | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Recomputes the "why" breakdown from stored factors + versioned weights.
 * The score must equal the stored impactScore (asserted in tests); a null
 * breakdown means the stored factors are missing or corrupt.
 */
export function buildImpactBreakdown(
  factorsJson: string | null,
): ImpactBreakdown | null {
  const factors = parseFactors(factorsJson);
  if (!factors) return null;
  const rows: ImpactBreakdownRow[] = IMPACT_FACTOR_NAMES.map((factor) => ({
    factor,
    weight: OPPORTUNITY_WEIGHTS[factor],
    value: factors[factor],
  }));
  const scored: ScoredFactor[] = rows.map((row) => ({
    weight: row.weight,
    value: row.value,
  }));
  return {
    rows,
    divisor: rows.reduce(
      (sum, row) => sum + (row.value === null ? 0 : row.weight),
      0,
    ),
    score: renormalizedScore(scored),
  };
}

function withBreakdown(row: OpportunityRow): OpportunityWithBreakdown {
  return {
    ...row,
    impactBreakdown: buildImpactBreakdown(row.impactFactorsJson),
    confidenceInputs: parseStringRecord(row.confidenceInputsJson),
  };
}

export async function listOpportunities(input: {
  projectId: string;
  status?: OpportunityStatus;
  type?: string;
  page?: string;
  keyword?: string;
  source?: string;
  priority?: string;
  statuses?: OpportunityStatus[];
  types?: string[];
  priorities?: string[];
}): Promise<OpportunityWithBreakdown[]> {
  const rows = await OpportunityRepository.listByProject(input.projectId, {
    status: input.status,
    type: input.type,
    page: input.page,
    keyword: input.keyword,
    source: input.source,
    priority: input.priority,
    statuses: input.statuses,
    types: input.types,
    priorities: input.priorities,
  });
  return [...rows]
    .toSorted((a, b) => compareOpportunities(toComparable(a), toComparable(b)))
    .map(withBreakdown);
}

export async function getOpportunity(input: {
  id: string;
  projectId: string;
}): Promise<{
  opportunity: OpportunityWithBreakdown;
  events: Awaited<
    ReturnType<typeof OpportunityRepository.listEventsByOccurrence>
  >;
} | null> {
  const opportunity = await OpportunityRepository.getByIdForProject(
    input.id,
    input.projectId,
  );
  if (!opportunity) return null;
  const events = await OpportunityRepository.listEventsByOccurrence(
    opportunity.id,
  );
  return { opportunity: withBreakdown(opportunity), events };
}

const ALLOWED_TRANSITIONS: Record<string, OpportunityStatus[]> = {
  open: ["in_progress", "completed", "dismissed"],
  in_progress: ["open", "completed", "dismissed"],
};

function allowedFrom(status: string): OpportunityStatus[] {
  // Terminal rows (completed/dismissed) and unknown statuses allow nothing:
  // re-detection never reopens, and users can't either (recurrence covers it).
  return ALLOWED_TRANSITIONS[status] ?? [];
}

export class InvalidStatusTransitionError extends AppError {
  constructor(from: string, to: string) {
    super("VALIDATION_ERROR", `Invalid opportunity transition ${from} → ${to}`);
  }
}

export async function updateOpportunityStatus(input: {
  id: string;
  projectId: string;
  organizationId: string;
  userId?: string;
  status: OpportunityStatus;
  reason?: string;
}): Promise<OpportunityRow> {
  const row = await OpportunityRepository.getByIdForProject(
    input.id,
    input.projectId,
  );
  if (!row) {
    throw new AppError("NOT_FOUND", "Opportunity not found");
  }
  if (row.status === input.status) return row;
  if (!allowedFrom(row.status).includes(input.status)) {
    throw new InvalidStatusTransitionError(row.status, input.status);
  }
  if (input.status === "dismissed" && !input.reason?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Dismissal requires a reason");
  }
  const now = new Date().toISOString();
  const updated = await OpportunityRepository.updateById(row.id, {
    status: input.status,
    completedAt: input.status === "completed" ? now : row.completedAt,
    dismissedAt: input.status === "dismissed" ? now : row.dismissedAt,
    dismissalReason:
      input.status === "dismissed"
        ? (input.reason ?? "").trim()
        : row.dismissalReason,
  });
  if (!updated) throw new AppError("NOT_FOUND", "Opportunity not found");
  const eventType =
    input.status === "completed" || input.status === "dismissed"
      ? input.status
      : "status_changed";
  await OpportunityRepository.insertEventIgnoreConflict({
    id: crypto.randomUUID(),
    occurrenceId: row.id,
    type: eventType,
    eventKey: await stableHash(
      `${row.id}|${eventType}|user|${input.status}|${now}`,
    ),
    scanId: null,
    payloadJson: JSON.stringify({
      from: row.status,
      to: input.status,
      reason: input.reason ?? null,
    }),
  });
  waitUntil(
    captureServerEvent({
      distinctId: input.userId ?? input.organizationId,
      event: "opportunity:status_change",
      organizationId: input.organizationId,
      properties: {
        project_id: input.projectId,
        opportunity_id: row.id,
        from: row.status,
        to: input.status,
      },
    }),
  );
  return updated;
}

export const OpportunityService = {
  listOpportunities,
  getOpportunity,
  updateOpportunityStatus,
};
