/* eslint-disable max-lines */
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Canonical JSON: object keys sorted recursively so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isJsonRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
 * Striking-distance band (spec 004, clarified 2026-09-28): positions 11–20
 * INCLUSIVE — page-one-adjacent quick wins with meaningful impressions. The
 * single shared definition for the `striking_distance` detector; the GSC
 * near-miss helper `buildStrikingDistanceRows` keeps its broader 5..20
 * dashboard band as a documented superset, never as the detector definition.
 */
export const STRIKING_DISTANCE_MIN_POSITION = 11;
export const STRIKING_DISTANCE_MAX_POSITION = 20;

/**
 * Canonical SEO page identity shared by joins and entityKey builders
 * (spec 006, hard gate G1). Extends the strict path policy from
 * `normalizeGa4LandingPage` — it never replaces it: GA4 sync storage keeps
 * strict path grain, while this helper is the single analytical identity for
 * cross-source page joins.
 *
 * Binding rules (spec 006 clarifications, 2026-09-30):
 * - Fold ONLY the conventional origin aliases: leading `www.` → bare host,
 *   `http` → `https`. All other subdomains stay distinct; non-default ports
 *   are preserved (WHATWG URL drops default :80/:443 automatically).
 * - Hosts are case-insensitive; paths keep their case (`/Blog` ≠ `/blog`).
 * - Non-root trailing slash folds away (`/blog` = `/blog/`); root `/` is
 *   preserved; duplicate slashes collapse.
 * - Fragments and query strings are excluded per the shared query policy.
 * - Percent-encoding is normalized safely: hex uppercased, unreserved
 *   characters decoded, everything else (incl. non-ASCII paths) preserved.
 * - Path-only rows (e.g. GA4 landing pages) resolve against the project's
 *   host context; without one they stay path-scoped — never an invented
 *   host. Blank/query-only input keeps the `(not set)` sentinel.
 * - Unparseable or non-http(s) input degrades to the deterministic strict
 *   path form — distinct per input, never a shared identity.
 * - This is an analytical join identity, NOT a claim about HTTP or Google
 *   canonical equivalence.
 */
export function canonicalUrl(
  value: string | null | undefined,
  hostContext?: string | null,
): string {
  const raw = (value ?? "").trim();
  if (raw === "") return normalizeGa4LandingPage(value);
  const absolute = tryParseHttpUrl(raw);
  if (absolute) return canonicalAbsoluteIdentity(absolute);
  const host = normalizeHostContext(hostContext);
  if (host) {
    const path = strictPathPart(raw);
    if (path === "") return normalizeGa4LandingPage(value);
    return canonicalAbsoluteIdentity(new URL(path, `https://${host}`));
  }
  return normalizeGa4LandingPage(raw);
}

/** Parse absolute http(s) URLs; anything else falls back to path handling. */
function tryParseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Strict path branch — mirrors `normalizeGa4LandingPage` without the
 * sentinel, so the identity composes the same path policy rather than
 * forking it. Empty (query/fragment-only) input stays empty for the caller
 * to map to the sentinel.
 */
function strictPathPart(raw: string): string {
  const path = raw.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (path === "") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Resolve a project host value (e.g. `projects.domain`: bare domain,
 * `sc-domain:` prefixed, or full URL) to a `host[:port]` identity part.
 * Returns null when no usable host exists — the caller keeps path scope.
 */
function normalizeHostContext(
  hostContext: string | null | undefined,
): string | null {
  const cleaned =
    (hostContext ?? "")
      .trim()
      .toLowerCase()
      .replace(/^sc-domain:/, "")
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.trim() ?? "";
  if (cleaned === "") return null;
  try {
    return new URL(`https://${cleaned}`).host;
  } catch {
    return null;
  }
}

/** Fold one parsed absolute URL to its canonical identity string. */
function canonicalAbsoluteIdentity(parsed: URL): string {
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const port = parsed.port !== "" ? `:${parsed.port}` : "";
  return `https://${host}${port}${foldSlashes(decodeSafePath(parsed.pathname))}`;
}

/**
 * Collapse duplicate slashes, then fold a single non-root trailing slash.
 * The root path is preserved as root.
 */
function foldSlashes(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

/**
 * Safe percent-encoding normalization: uppercase hex, decode RFC 3986
 * unreserved characters only. Reserved/UTF-8 sequences stay encoded so
 * non-ASCII paths are never mangled and encoded/decoded alias pairs agree.
 */
function decodeSafePath(pathname: string): string {
  return pathname.replace(/%[0-9A-Fa-f]{2}/g, (sequence) => {
    const upper = sequence.toUpperCase();
    const char = String.fromCharCode(Number.parseInt(upper.slice(1), 16));
    if (/^[A-Za-z0-9\-_.~]$/.test(char)) return char;
    return upper;
  });
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
  const pages = [canonicalUrl(firstUrl), canonicalUrl(secondUrl)].toSorted();
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
export function buildInsightKey(composerKey: string, groupKey: string): string {
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
    metrics: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    periods: z.object({ from: z.string(), to: z.string() }).strict().optional(),
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

export type InsightSeverity = z.infer<typeof insightSeveritySchema>;

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
    periods: z.object({ from: z.string(), to: z.string() }).strict().optional(),
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

// ---------------------------------------------------------------------------
// Dashboard stored-rollup contracts (spec 001, Track A milestone A0).
// Read-only view-model types for the eight intelligence output groups.
// Failure states never carry zeroed metrics — unavailable stays unavailable.
// ---------------------------------------------------------------------------

/** Every dashboard section renders exactly one of these states. */
export const DASHBOARD_SECTION_STATES = [
  "loading",
  "ready",
  "empty",
  "not_connected",
  "no_data",
  "partial",
  "stale",
  "api_failed",
  "permission_failed",
  "sync_running",
  "sync_failed",
] as const;
export type DashboardSectionState = (typeof DASHBOARD_SECTION_STATES)[number];

/** Current value plus the equivalent previous window. A null previous means
 *  prior coverage was missing/insufficient — change fields stay null (never
 *  synthetic 0%, +100%, or -100%). */
export type PeriodDelta = {
  current: number;
  previous: number | null;
  change: number | null;
  changePct: number | null;
};

/** Which source a section read, how fresh it is, and whether it is complete. */
export type CoverageNote = {
  source:
    | "gsc"
    | "ga4"
    | "rank"
    | "opportunities"
    | "insights"
    | "audit"
    | "backlinks";
  freshness: string | null;
  completeness: "full" | "partial" | "none";
  detail: string | null;
};

/** Percent change mirroring the analytics delta rule: a zero previous period
 *  with nonzero current is unknown (null), not infinite. */
export function dashboardPctChange(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** Build a PeriodDelta. Pass null previous when prior-period coverage is
 *  missing or insufficient — the delta stays unavailable by construction. */
export function toPeriodDelta(
  current: number,
  previous: number | null,
): PeriodDelta {
  if (previous === null) {
    return { current, previous: null, change: null, changePct: null };
  }
  return {
    current,
    previous,
    change: current - previous,
    changePct: dashboardPctChange(current, previous),
  };
}

/** Deterministic precedence for the unified dashboard section-state model
 *  (spec 011, A2). First match wins; failure states always beat
 *  data-availability states, which always beat `ready` — so failure can
 *  never surface as zero, empty, or ready. */
export const SECTION_STATE_PRECEDENCE = [
  "loading",
  "not_connected",
  "permission_failed",
  "sync_running",
  "sync_failed",
  "api_failed",
  "no_data",
  "empty",
  "stale",
  "partial",
  "ready",
] as const satisfies readonly DashboardSectionState[];

/** Stored-read outcome flags for one dashboard section. Extended by spec 011
 *  (A2): `loading`, `permissionDenied`, `readFailed`, `hasItems`, `stale`
 *  default so existing callers keep their shape. */
export type MapStoredSectionStateInput = {
  connected: boolean;
  hasCurrent: boolean;
  hasPrevious: boolean;
  syncRunning: boolean;
  syncFailed: boolean;
  /** Section read is in flight — renders the loading skeleton. */
  loading?: boolean;
  /** Source denied access (plan gate, revoked grant) — explicit CTA. */
  permissionDenied?: boolean;
  /** Stored read threw outside the sync lifecycle — explicit failure. */
  readFailed?: boolean;
  /** List sections only: false when the read succeeded with zero items
   *  (renders `empty`); null/undefined means "not a list section". */
  hasItems?: boolean | null;
  /** Current coverage exists but is past the freshness bound. */
  stale?: boolean;
};

/** Map stored-read outcomes to a section state. Failure inputs (failed sync,
 *  exceptions, denied permission) map to failure states — never to
 *  ready-with-zeros, never to empty. */
export function mapStoredSectionState(
  input: MapStoredSectionStateInput,
): DashboardSectionState {
  if (input.loading === true) return "loading";
  if (!input.connected) return "not_connected";
  if (input.permissionDenied === true) return "permission_failed";
  // Sync states surface only when there is no current-window coverage to
  // show: with current data the section keeps its data state and annotates
  // via coverage.detail (preserved spec-001 behavior — data is never hidden
  // behind a sync indicator). Without current coverage they beat no_data so
  // a running/failed sync is never mistaken for "nothing was ever synced".
  if (!input.hasCurrent && input.syncRunning) return "sync_running";
  if (!input.hasCurrent && input.syncFailed) return "sync_failed";
  if (input.readFailed === true) return "api_failed";
  if (!input.hasCurrent && !input.hasPrevious) return "no_data";
  if (input.hasItems === false) return "empty";
  if (input.stale === true) return "stale";
  if (!input.hasPrevious) return "partial";
  return "ready";
}
