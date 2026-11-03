import type {
  GlobalTraceFilter,
  GlobalTraceKeywordChild,
  GlobalTraceOperation,
  GlobalTraceProviderCall,
  GlobalTraceStatus,
} from "@/shared/globalTraceTypes";

export function formatTraceDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatPositionPair(
  before: number | null | undefined,
  after: number | null | undefined,
): string {
  return `${before != null ? `#${before}` : "—"} → ${
    after != null ? `#${after}` : "—"
  }`;
}

/**
 * Human-readable positions for a rank-check keyword child.
 * With per-device data (from buildKeywordChild): labelled per-device pairs,
 * e.g. "Desktop — → — · Mobile #6 → #6", so a pair is never read as a mix of
 * two devices. Fallbacks to the single aggregated pair for children built
 * without per-device details. Returns null when there is nothing to render.
 */
export function formatKeywordChildPositions(
  child: Pick<
    GlobalTraceKeywordChild,
    "devices" | "positionBefore" | "positionAfter"
  >,
): string | null {
  if (child.devices && child.devices.length > 0) {
    return child.devices
      .map(
        (segment) =>
          `${segment.device === "mobile" ? "Mobile" : "Desktop"} ${formatPositionPair(
            segment.positionBefore,
            segment.positionAfter,
          )}`,
      )
      .join(" · ");
  }
  if (child.positionBefore === undefined && child.positionAfter === undefined) {
    return null;
  }
  return formatPositionPair(child.positionBefore, child.positionAfter);
}

export function formatProviderBreakdown(
  breakdown?: Array<{ provider: string; count: number }>,
): string {
  if (!breakdown || breakdown.length === 0) return "No provider calls";
  return breakdown.map((item) => `${item.provider} ×${item.count}`).join(" · ");
}

export function computeProviderBreakdown(
  providers?: GlobalTraceProviderCall[],
): Array<{ provider: string; count: number }> {
  if (!providers || providers.length === 0) return [];
  const map = new Map<string, number>();
  for (const call of providers) {
    const key = call.provider || "Unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([provider, count]) => ({
    provider,
    count,
  }));
}

export function statusLabel(status: GlobalTraceStatus): string {
  switch (status) {
    case "running":
      return "Running…";
    case "success":
      return "SUCCESS";
    case "failed":
      return "FAILED";
    case "blocked":
      return "BLOCKED";
    default:
      return String(status).toUpperCase();
  }
}

export function filterOperations(
  operations: GlobalTraceOperation[],
  filter: GlobalTraceFilter,
): GlobalTraceOperation[] {
  switch (filter) {
    case "all":
      return operations;
    case "errors":
      return operations.filter(
        (op) =>
          op.status === "failed" ||
          (typeof op.httpStatus === "number" && op.httpStatus >= 400) ||
          op.errorClass ||
          op.errorMessage,
      );
    case "providers":
      return operations.filter(
        (op) => (op.providerCalls ?? 0) > 0 || (op.providers?.length ?? 0) > 0,
      );
    case "network":
      return operations.filter(
        (op) =>
          typeof op.httpStatus === "number" ||
          op.providers?.some((p) => typeof p.httpStatus === "number"),
      );
    case "billing":
      return operations.filter(
        (op) =>
          op.billing !== undefined ||
          op.budget !== undefined ||
          op.status === "blocked" ||
          op.cost !== undefined,
      );
    case "cache":
      return operations.filter(
        (op) =>
          op.cache === "HIT" ||
          op.cache === "MISS" ||
          op.cacheType !== undefined,
      );
    case "rank_tracking":
      return operations.filter((op) => op.feature === "rank_tracking");
    case "seo":
      return operations.filter(
        (op) =>
          op.feature === "keyword_research" ||
          op.feature === "domain_overview" ||
          op.feature === "backlinks" ||
          op.feature === "site_audit" ||
          op.feature === "search_console" ||
          op.feature === "saved_keywords" ||
          op.feature === "brand_lookup" ||
          op.feature === "prompt_explorer" ||
          // Spec 010: GA4 analytics reads sit with the other SEO surfaces.
          op.feature === "analytics" ||
          // Spec 014: competitor-gap spike operations (observability only).
          op.feature === "competitor_gap",
      );
    case "settings":
      return operations.filter((op) => op.feature === "settings");
    default:
      return operations;
  }
}
