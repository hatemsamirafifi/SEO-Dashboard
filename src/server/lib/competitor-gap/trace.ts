// Spec 014 (T019) — competitor-gap observability seam.
//
// The Global Trace store is client-side (globalTraceStore) and the SAM trace
// bus is ambient per-turn (no-op outside a turn). A background spike runs in
// NEITHER context, so this module emits structured log lines in the repo's
// existing `[seo-data]` style (cost-tracker logRequest), scrubbed of any
// credential-shaped text (P41). Consumers that need UI-visible operations can
// wrap `runSpike` in `traceServerCall({ feature: "competitor_gap", ... })`.
//
// What these rows carry (P41-appropriate): operation, verdict, per-dimension
// status classes, counts, durationMs, cost metadata. Never: domains are safe
// display labels per globalTraceTypes precedent; everything else is
// scrubbed and credential-free by construction (no tokens pass this seam).

import { scrubGlobalTraceText } from "@/shared/globalTraceTypes";
import type {
  CompetitorGapGateState,
  CompetitorGapSpikeManifest,
  CompetitorGapVerdict,
} from "@/shared/competitorGap";

export type SpikeTraceRow = {
  operation: "competitor_gap_spike_measure" | "competitor_gap_verdict_record";
  organizationId: string;
  projectId: string;
  verdict?: CompetitorGapVerdict;
  gateState?: CompetitorGapGateState;
  dimensionStatuses?: Record<string, string>;
  durationMs?: number;
  sampleDomains?: number;
  measuredCreditsPerAnalysis?: number | "unavailable";
  error?: string;
};

/**
 * Emit one structured observability row. Scrubbed (P41); never throws —
 * tracing failures must not break the spike.
 */
export function traceSpikeEvent(row: SpikeTraceRow): void {
  try {
    const parts = [
      `operation=${row.operation}`,
      `org=${row.organizationId}`,
      `project=${row.projectId}`,
      row.verdict ? `verdict=${row.verdict}` : null,
      row.gateState ? `gate=${row.gateState}` : null,
      row.dimensionStatuses
        ? `dimensions=${JSON.stringify(row.dimensionStatuses)}`
        : null,
      typeof row.durationMs === "number" ? `duration=${row.durationMs}ms` : null,
      typeof row.sampleDomains === "number"
        ? `sampleDomains=${row.sampleDomains}`
        : null,
      typeof row.measuredCreditsPerAnalysis === "number"
        ? `credits=${row.measuredCreditsPerAnalysis}`
        : row.measuredCreditsPerAnalysis === "unavailable"
          ? `credits=unavailable`
          : null,
      row.error ? `error=${row.error}` : null,
    ].filter(Boolean);
    console.log(
      scrubGlobalTraceText(`[competitor-gap] ${parts.join(" ")}`),
    );
  } catch {
    // Tracing must never break the spike.
  }
}

/** Manifest metadata for log rows (counts only — never keyword text). */
export function manifestMeta(
  manifest: CompetitorGapSpikeManifest,
): Pick<SpikeTraceRow, "organizationId" | "projectId" | "sampleDomains"> {
  return {
    organizationId: manifest.organizationId,
    projectId: manifest.projectId,
    sampleDomains: manifest.sampleDomains.length,
  };
}