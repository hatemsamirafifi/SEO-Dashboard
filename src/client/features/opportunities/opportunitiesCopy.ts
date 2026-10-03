/**
 * Pure view-model, metadata, filter, and formatting helpers for the
 * opportunities UI (final-plan §17). No data fetching here — behavior is
 * covered through these helpers (no jsdom in the repo, Tasks 1–8 precedent).
 */

export const OPPORTUNITY_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "dismissed",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_TYPES = [
  "traffic",
  "ga4_traffic",
  "ctr",
  "decay",
  "ranking",
  "cannibalization",
  "technical",
  "backlinks",
  "lost_backlinks",
  "striking_distance",
  // Spec 010: GA4-backed detector types.
  "ga4_conversion",
  "ga4_engagement",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_PRIORITIES = [
  "Critical",
  "High",
  "Medium",
  "Low",
] as const;
export type OpportunityPriority = (typeof OPPORTUNITY_PRIORITIES)[number];

export const STATUS_META: Record<
  OpportunityStatus,
  { label: string; badgeClass: string }
> = {
  open: { label: "Open", badgeClass: "badge-info" },
  in_progress: { label: "In progress", badgeClass: "badge-warning" },
  completed: { label: "Completed", badgeClass: "badge-success" },
  dismissed: { label: "Dismissed", badgeClass: "badge-ghost" },
};

export const TYPE_META: Record<OpportunityType, { label: string }> = {
  traffic: { label: "Traffic change" },
  ga4_traffic: { label: "GA4 traffic change" },
  ctr: { label: "Low CTR" },
  decay: { label: "Content decay" },
  ranking: { label: "Ranking drop" },
  cannibalization: { label: "Cannibalization" },
  technical: { label: "Technical" },
  backlinks: { label: "Backlinks" },
  lost_backlinks: { label: "Lost backlinks" },
  striking_distance: { label: "Striking distance" },
  ga4_conversion: { label: "Conversion drop" },
  ga4_engagement: { label: "Engagement drop" },
};

/** Evidence source vocabulary (DetectionSource union): the fixed option set
 *  for the server-side source filter. Unknown future values render
 *  neutrally, never crash. */
export const OPPORTUNITY_SOURCES = [
  "gsc",
  "ga4",
  "rank",
  "audit",
  "backlinks",
] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const SOURCE_META: Record<OpportunitySource, { label: string }> = {
  gsc: { label: "Search Console" },
  ga4: { label: "Analytics" },
  rank: { label: "Rank tracking" },
  audit: { label: "Site audit" },
  backlinks: { label: "Backlinks" },
};

function isSourceValue(value: string): value is OpportunitySource {
  return (OPPORTUNITY_SOURCES as readonly string[]).includes(value);
}

export function sourceLabel(source: string): string {
  return isSourceValue(source) ? SOURCE_META[source].label : source;
}

/** Narrow a raw priority select value to a server filter param. Unknown
 *  values mean unfiltered rather than reaching the validator as garbage
 *  (AnalyticsFilterToolbar.toDeviceParam precedent). */
export function toPriorityParam(value: string): OpportunityPriority | undefined {
  return isPriorityValue(value) ? value : undefined;
}

export const PRIORITY_META: Record<
  OpportunityPriority,
  { label: string; badgeClass: string }
> = {
  Critical: { label: "Critical", badgeClass: "badge-error" },
  High: { label: "High", badgeClass: "badge-warning" },
  Medium: { label: "Medium", badgeClass: "badge-info" },
  Low: { label: "Low", badgeClass: "badge-ghost" },
};

function isStatusValue(value: string): value is OpportunityStatus {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

function isPriorityValue(value: string): value is OpportunityPriority {
  return (OPPORTUNITY_PRIORITIES as readonly string[]).includes(value);
}

function isTypeValue(value: string): value is OpportunityType {
  return (OPPORTUNITY_TYPES as readonly string[]).includes(value);
}

/** Badge-safe lookups: unknown future values render neutrally, never crash. */
export function statusLabel(status: string): string {
  return isStatusValue(status) ? STATUS_META[status].label : status;
}

export function statusBadgeClass(status: string): string {
  return `badge ${isStatusValue(status) ? STATUS_META[status].badgeClass : "badge-ghost"} badge-sm`;
}

export function priorityLabel(priority: string): string {
  return isPriorityValue(priority) ? PRIORITY_META[priority].label : priority;
}

export function priorityBadgeClass(priority: string): string {
  return `badge ${isPriorityValue(priority) ? PRIORITY_META[priority].badgeClass : "badge-ghost"} badge-sm`;
}

export function typeLabel(type: string): string {
  return isTypeValue(type) ? TYPE_META[type].label : type;
}

export const FACTOR_META: Record<string, { label: string }> = {
  trafficPotential: { label: "Traffic potential" },
  proximity: { label: "Proximity" },
  decline: { label: "Decline" },
  businessIntent: { label: "Business intent" },
  conversionSignal: { label: "Conversion signal" },
};

export function factorLabel(factor: string): string {
  return FACTOR_META[factor]?.label ?? factor;
}

/** camelCase confidence keys → "Coverage day ratio" for display. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const EVENT_META: Record<string, { label: string }> = {
  detected: { label: "Detected" },
  redetected: { label: "Seen again" },
  rescored: { label: "Rescored" },
  evidence_updated: { label: "Evidence updated" },
  status_changed: { label: "Status changed" },
  stale_marked: { label: "Marked stale" },
  stale_cleared: { label: "No longer stale" },
  completed: { label: "Completed" },
  dismissed: { label: "Dismissed" },
  recurred: { label: "Recurred" },
  superseded: { label: "Superseded" },
};

export function eventLabel(type: string): string {
  return EVENT_META[type]?.label ?? type;
}

export type OpportunitiesPageView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "filtered-empty" }
  | { kind: "ok" };

/** Distinct list states: provider failure is an error line, an empty project
 *  explains scheduling, and filters that match nothing say so explicitly. */
export function toOpportunitiesPageView(input: {
  isPending: boolean;
  isError: boolean;
  totalCount: number;
  filteredCount: number;
}): OpportunitiesPageView {
  if (input.isPending) return { kind: "loading" };
  if (input.isError) return { kind: "error" };
  if (input.totalCount === 0) return { kind: "empty" };
  if (input.filteredCount === 0) return { kind: "filtered-empty" };
  return { kind: "ok" };
}

export type OpportunityFilterRow = {
  type: string;
  priority: string;
  keyword: string | null;
  page: string | null;
  title: string;
  logicalKey: string;
};

export type ClientOpportunityFilters = {
  search: string;
};

/** Client-side refinement over the server-filtered rows (spec 010, R4):
 *  free-text search only — type/priority/page/keyword/source/status all
 *  filter server-side. Search matches keyword, page, title, and key. */
export function applyClientFilters<Row extends OpportunityFilterRow>(
  rows: Row[],
  filters: ClientOpportunityFilters,
): Row[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (search) {
      const haystack = [row.keyword, row.page, row.title, row.logicalKey]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export type EvidenceView = {
  metrics: Record<string, string | number | boolean>;
  periods?: { from: string; to: string };
  sources: string[];
  sourceRefs?: {
    gscFactIds?: string[];
    rankSnapshotIds?: Array<string | number>;
    auditIssueIds?: string[];
    ga4Keys?: string[];
  };
  thresholdsApplied?: Record<string, string | number | boolean>;
  partialData?: string[];
};

function isMetricRecord(
  value: unknown,
): value is Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean",
  );
}

/** Validated parse of the frozen evidence JSON; null when absent or corrupt
 *  (corrupt evidence surfaces as an explicit note, never fabricated rows). */
export function parseEvidenceJson(json: string | null): EvidenceView | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("metrics" in parsed) || !isMetricRecord(parsed.metrics)) return null;
  if (!("sources" in parsed) || !Array.isArray(parsed.sources)) return null;
  const sources: string[] = [];
  for (const source of parsed.sources) {
    if (typeof source !== "string") return null;
    sources.push(source);
  }
  const view: EvidenceView = { metrics: parsed.metrics, sources };
  if (
    "periods" in parsed &&
    typeof parsed.periods === "object" &&
    parsed.periods !== null &&
    "from" in parsed.periods &&
    typeof parsed.periods.from === "string" &&
    "to" in parsed.periods &&
    typeof parsed.periods.to === "string"
  ) {
    view.periods = { from: parsed.periods.from, to: parsed.periods.to };
  }
  if (
    "thresholdsApplied" in parsed &&
    isMetricRecord(parsed.thresholdsApplied)
  ) {
    view.thresholdsApplied = parsed.thresholdsApplied;
  }
  if ("partialData" in parsed && Array.isArray(parsed.partialData)) {
    const partialData: string[] = [];
    for (const entry of parsed.partialData) {
      if (typeof entry !== "string") return null;
      partialData.push(entry);
    }
    view.partialData = partialData;
  }
  // Source references (spec 010: ga4Keys joins the existing gsc/rank/audit
  // refs). String arrays only; malformed refs invalidate the whole view —
  // corrupt evidence surfaces as an explicit note, never fabricated rows.
  if ("sourceRefs" in parsed && isRecord(parsed.sourceRefs)) {
    const refs: NonNullable<EvidenceView["sourceRefs"]> = {};
    for (const key of ["gscFactIds", "rankSnapshotIds", "auditIssueIds", "ga4Keys"] as const) {
      if (key in parsed.sourceRefs) {
        const values = stringArrayValue(parsed.sourceRefs[key]);
        if (values === null) return null;
        refs[key] = values;
      }
    }
    if (Object.keys(refs).length > 0) view.sourceRefs = refs;
  }
  return view;
}

/** String-array guard for frozen-evidence source refs: plain strings pass,
 *  numbers stringify (rank snapshot ids), anything else invalidates. */
function stringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" && typeof entry !== "number") return null;
    out.push(String(entry));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Dismissal reason tucked into lifecycle event payloads, if present. */
export function parseEventReason(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "reason" in parsed &&
    typeof parsed.reason === "string" &&
    parsed.reason.trim() !== ""
  ) {
    return parsed.reason;
  }
  return null;
}

/** Dismissal requires a reason (plan §10 lifecycle); returns the error to
 *  display, or null when the reason is acceptable. */
export function validateDismissalReason(reason: string): string | null {
  if (!reason.trim()) return "A reason is required to dismiss an opportunity.";
  if (reason.trim().length > 500) {
    return "Keep the reason under 500 characters.";
  }
  return null;
}

/** "Jan 5, 2026, 1:30 PM" in en-US; em dash when the timestamp is missing. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "\u2014";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "\u2014";
  return (
    new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) +
    ", " +
    new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })
  );
}

/** Miss/stale footnote for list rows and detail headers. */
export function formatMissInfo(input: {
  consecutiveMisses: number;
  stale: boolean;
}): string | null {
  if (input.stale) {
    return `Stale — not seen in the last ${Math.max(input.consecutiveMisses, 3)} scans.`;
  }
  if (input.consecutiveMisses === 1) return "Not seen in the last scan.";
  if (input.consecutiveMisses === 2) return "Not seen in the last 2 scans.";
  return null;
}
