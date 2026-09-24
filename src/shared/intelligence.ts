import { z } from "zod";
import { normalizeGa4LandingPage } from "./ga4";

/**
 * Frozen intelligence contracts (final-plan §§2–4). These shapes are consumed
 * by detectors (Tasks 7/10), the opportunity materializer (Task 8), the
 * insight composer (Task 11), reports (Task 12), and autopilot (Tasks 15/16).
 * Treat them as frozen: later changes require backward-compatible extension
 * plus task-scoped migration/tests.
 *
 * Structural locks enforced by tests:
 * - No combined-score key exists anywhere (impact and confidence stay
 *   separate; see the absence test).
 * - No causal-attribution field exists on any evidence/correlation schema
 *   (MVP output is correlation-only; only future provider-confirmed /
 *   manual-assertion evidence classes may unlock causal phrasing).
 */

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (content addressing, version tokens)
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted recursively so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256HexFull(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stable content hash over any JSON value. Returns the FULL 64-hex digest —
 * never truncated prefixes (final-plan §6: keys embed full digests).
 */
export async function stableHash(value: unknown): Promise<string> {
  return sha256HexFull(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Canonical entity keys (one shared helper per family)
// ---------------------------------------------------------------------------

/** Lowercased keywords: detector, join, and opportunity keys must agree. */
export function canonicalKeyword(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Normalized page identity shared by sync, joins, and entityKey builders.
 * Delegates to `normalizeGa4LandingPage` so GA4 landing rows, join keys, and
 * opportunity keys can never disagree on page identity.
 */
export function canonicalUrl(value: string | null | undefined): string {
  return normalizeGa4LandingPage(value);
}

/** Technical issues include the issue discriminator in the entity key. */
export function canonicalTechnicalKey(
  issueType: string,
  page: string | null | undefined,
): string {
  return `technical:${(issueType ?? "").trim().toLowerCase()}:${canonicalUrl(page)}`;
}

/** Rank drops include device + market in the entity key. */
export function canonicalRankKey(
  keyword: string,
  device: string | null | undefined,
  market: string | null | undefined,
): string {
  const devicePart = (device ?? "").trim().toLowerCase();
  const marketPart = (market ?? "").trim().toLowerCase();
  return `rank:${canonicalKeyword(keyword)}:${devicePart}:${marketPart}`;
}

/** Cannibalization identity = sorted URL pair + query. */
export function canonicalCannibalizationPair(
  firstUrl: string,
  secondUrl: string,
  query: string,
): string {
  const pages = [canonicalUrl(firstUrl), canonicalUrl(secondUrl)].sort();
  return `cannibalization:${canonicalKeyword(query)}:${pages[0]}:${pages[1]}`;
}

// ---------------------------------------------------------------------------
// Identity builders
// ---------------------------------------------------------------------------

/**
 * `findingKey = sha256Hex(projectId|detectorKey|detectorVersion|
 * entityKey|periodFrom|periodTo)` — full digest, transient per-scan identity.
 */
export async function buildFindingKey(input: {
  projectId: string;
  detectorKey: string;
  detectorVersion: number;
  entityKey: string;
  periodFrom: string;
  periodTo: string;
}): Promise<string> {
  return sha256HexFull(
    [
      input.projectId,
      input.detectorKey,
      String(input.detectorVersion),
      input.entityKey,
      input.periodFrom,
      input.periodTo,
    ].join("|"),
  );
}

/**
 * `logicalKey = detectorKey:entityKey` (no period — stable across scans).
 */
export function buildOpportunityLogicalKey(
  detectorKey: string,
  entityKey: string,
): string {
  return `${detectorKey}:${entityKey}`;
}

/** `insight_key = composerKey:groupKey`. */
export function buildInsightKey(
  composerKey: string,
  groupKey: string,
): string {
  return `${composerKey}:${groupKey}`;
}

// ---------------------------------------------------------------------------
// Score bands, priority matrix, canonical sort, renormalization
// ---------------------------------------------------------------------------

export const IMPACT_BANDS = ["Critical", "High", "Medium", "Low"] as const;
export type ImpactBand = (typeof IMPACT_BANDS)[number];

export const CONFIDENCE_BANDS = ["High", "Medium", "Low"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const PRIORITIES = ["Critical", "High", "Medium", "Low"] as const;
export type OpportunityPriority = (typeof PRIORITIES)[number];

/** Impact bands: Critical ≥80 / High ≥60 / Medium ≥40 / Low <40. */
export function impactBandOf(score: number): ImpactBand {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

/** Confidence bands: High ≥70 / Medium ≥40 / Low <40. */
export function confidenceBandOf(score: number): ConfidenceBand {
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

/**
 * Deterministic priority matrix (§2): Critical+High→Critical;
 * Critical+Med / High+High / High+Med→High;
 * Critical+Low / High+Low / Med+High / Med+Med→Medium; else Low.
 */
export function priorityMatrix(
  impact: ImpactBand,
  confidence: ConfidenceBand,
): OpportunityPriority {
  if (impact === "Critical" && confidence === "High") return "Critical";
  if (
    (impact === "Critical" && confidence === "Medium") ||
    (impact === "High" && confidence !== "Low")
  )
    return "High";
  if (
    (impact === "Critical" && confidence === "Low") ||
    (impact === "High" && confidence === "Low") ||
    (impact === "Medium" && confidence !== "Low")
  )
    return "Medium";
  return "Low";
}

const PRIORITY_RANK: Record<OpportunityPriority, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

/**
 * Canonical sort everywhere: priority DESC, impactScore DESC,
 * confidenceScore DESC, lastDetectedAt DESC (single shared comparator).
 */
export function compareOpportunities(
  first: {
    priority: OpportunityPriority;
    impactScore: number;
    confidenceScore: number;
    lastDetectedAt: string;
  },
  second: {
    priority: OpportunityPriority;
    impactScore: number;
    confidenceScore: number;
    lastDetectedAt: string;
  },
): number {
  if (PRIORITY_RANK[first.priority] !== PRIORITY_RANK[second.priority]) {
    return PRIORITY_RANK[second.priority] - PRIORITY_RANK[first.priority];
  }
  if (first.impactScore !== second.impactScore) {
    return second.impactScore - first.impactScore;
  }
  if (first.confidenceScore !== second.confidenceScore) {
    return second.confidenceScore - first.confidenceScore;
  }
  if (first.lastDetectedAt !== second.lastDetectedAt) {
    return first.lastDetectedAt < second.lastDetectedAt ? 1 : -1;
  }
  return 0;
}

export type ScoredFactor = {
  weight: number;
  /** Null = factor unavailable (renormalized out of the divisor, never zero). */
  value: number | null;
};

/**
 * Renormalized impact score: `round(100 × Σ(wᵢ·fᵢ)/Σ(w available))`.
 * Missing optional data never scores 0 — the divisor shrinks. An empty
 * available set returns null (no materialization, skip recorded).
 */
export function renormalizedScore(factors: ScoredFactor[]): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const factor of factors) {
    if (factor.value === null) continue;
    weightedSum += factor.weight * factor.value;
    weightSum += factor.weight;
  }
  if (weightSum === 0) return null;
  return Math.round((100 * weightedSum) / weightSum);
}

// ---------------------------------------------------------------------------
// Evidence schemas (Zod)
// ---------------------------------------------------------------------------

const sourceNameSchema = z.enum([
  "gsc",
  "ga4",
  "rank",
  "audit",
  "backlinks",
  "keywords",
  "competitors",
]);

const sourceRefsSchema = z
  .object({
    gscFactIds: z.array(z.string()).optional(),
    rankSnapshotIds: z.array(z.union([z.string(), z.number()])).optional(),
    auditIssueIds: z.array(z.string()).optional(),
    ga4Keys: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Overlap-only correlation entry. There is deliberately NO causal-attribution
 * field — MVP automated output is correlation-only ("consistent with…").
 */
const correlationSchema = z
  .object({
    entityRef: z.string(),
    sharedWindow: z
      .object({ from: z.string(), to: z.string() })
      .strict()
      .optional(),
    note: z.string(),
  })
  .strict();

const findingEvidenceSchema = z
  .object({
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    periods: z
      .object({ from: z.string(), to: z.string() })
      .strict()
      .optional(),
    sources: z.array(sourceNameSchema),
    sourceRefs: sourceRefsSchema.optional(),
    thresholdsApplied: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    correlations: z.array(correlationSchema),
    evidenceType: z.literal("observational"),
    partialData: z.array(z.string()),
    confidenceInputs: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();

export const findingSchema = z
  .object({
    findingKey: z.string().length(64),
    detectorKey: z.string().min(1),
    detectorVersion: z.number().int().min(1),
    projectId: z.string().min(1),
    entityKey: z.string().min(1),
    entity: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]).optional(),
    ),
    // Detectors emit fact-only prose; recommendations are added exclusively
    // by the materializer/composer (final-plan §4 fact/recommendation split).
    explanationFact: z.string().min(1),
    evidence: findingEvidenceSchema,
    detectedAt: z.string().min(1),
    confidenceScore: z.number().min(0).max(100),
    coverageFlags: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

export const insightSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "info",
]);

/**
 * Insight — user-facing interpretation of ≥1 findings. No lifecycle status.
 */
export const insightSchema = z
  .object({
    insightKey: z.string().min(1),
    composerKey: z.string().min(1),
    severity: insightSeveritySchema,
    title: z.string().min(1),
    explanationFact: z.string().min(1),
    recommendation: z.string().optional(),
    evidenceSummary: z.string().min(1),
    entityRefs: z.array(z.string()),
    periods: z
      .object({ from: z.string(), to: z.string() })
      .strict()
      .optional(),
    sources: z.array(sourceNameSchema),
    findingKeys: z.array(z.string()),
    opportunityIds: z.array(z.string()),
    contentVersion: z.number().int().min(1),
    contentHash: z.string().min(1),
    scanId: z.string().min(1),
    detectedAt: z.string().min(1),
    lastSeenAt: z.string().min(1),
    resolvedAt: z.string().nullable().optional(),
  })
  .strict();

export type Insight = z.infer<typeof insightSchema>;

export const opportunityStatusSchema = z.enum([
  "open",
  "in_progress",
  "completed",
  "dismissed",
]);

/**
 * Opportunity — actionable item with lifecycle. Impact and confidence remain
 * separately inspectable; there is no combined-score column or key.
 */
export const opportunitySchema = z
  .object({
    logicalKey: z.string().min(1),
    occurrenceNumber: z.number().int().min(1),
    type: z.string().min(1),
    detectorKey: z.string().min(1),
    detectorVersion: z.number().int().min(1),
    scoreVersion: z.number().int().min(1),
    status: opportunityStatusSchema,
    impactScore: z.number().min(0).max(100),
    confidenceScore: z.number().min(0).max(100),
    priority: z.enum(PRIORITIES),
    title: z.string().min(1),
    explanationFact: z.string().min(1),
    recommendation: z.string().min(1),
    evidence: z
      .object({
        metrics: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()]),
        ),
        periods: z
          .object({ from: z.string(), to: z.string() })
          .strict()
          .optional(),
        sources: z.array(sourceNameSchema),
        sourceRefs: sourceRefsSchema.optional(),
      })
      .strict(),
    keyword: z.string().nullable().optional(),
    page: z.string().nullable().optional(),
    sourceMetrics: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    sources: z.array(sourceNameSchema),
    lastSeenScanId: z.string().nullable().optional(),
    consecutiveMisses: z.number().int().min(0),
    stale: z.boolean(),
    recurrenceOfId: z.string().nullable().optional(),
    supersededById: z.string().nullable().optional(),
    firstDetectedAt: z.string().min(1),
    lastDetectedAt: z.string().min(1),
    completedAt: z.string().nullable().optional(),
    dismissedAt: z.string().nullable().optional(),
  })
  .strict();

export type Opportunity = z.infer<typeof opportunitySchema>;
