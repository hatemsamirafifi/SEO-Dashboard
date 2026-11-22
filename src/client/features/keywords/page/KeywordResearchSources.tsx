import type { KeywordResearchRow } from "@/types/keywords";
import {
  KEYWORD_SOURCE_LABELS,
  KEYWORD_SOURCE_STATUS_LABELS,
} from "@/shared/keyword-research-sources";
import type { ResearchDiagnostics } from "@/server/features/keywords/services/research/research";

export function KeywordRowSources({ row }: { row: KeywordResearchRow }) {
  if (!row.attribution?.length) return null;
  return (
    <div className="flex flex-wrap gap-x-2 text-xs text-base-content/70">
      {row.attribution.map(
        ({ source, observedAt, cacheStatus, sitePerformance }) => (
          <span
            key={source}
            title={observedAt ? `${cacheStatus} · ${observedAt}` : cacheStatus}
          >
            {KEYWORD_SOURCE_LABELS[source]}
            {sitePerformance?.impressions != null && (
              <>
                {" "}
                · {sitePerformance.impressions.toLocaleString()} site
                impressions
              </>
            )}
          </span>
        ),
      )}
    </div>
  );
}

export function KeywordResearchSources({
  diagnostics,
}: {
  diagnostics?: ResearchDiagnostics;
}) {
  if (!diagnostics?.coverage) return null;
  const { sourceAttempts, servingProviders, coverage } = diagnostics;
  return (
    <details
      className="shrink-0 rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-sm"
      open={coverage === "empty"}
    >
      <summary className="cursor-pointer font-medium">
        {coverage === "partial" ? "Partial results · " : ""}Keyword sources
        {servingProviders?.length
          ? ` · ${servingProviders.map((source) => KEYWORD_SOURCE_LABELS[source]).join(", ")}`
          : ""}
      </summary>
      <ul className="mt-2 space-y-1 text-base-content/80">
        {sourceAttempts.map(
          ({ source, provider, status, rowCount, reason, fromCache }) =>
            provider && status ? (
              <li key={source}>
                {KEYWORD_SOURCE_LABELS[provider]}
                {provider === "seranking" ? ` (${source})` : ""}
                {" · "}
                {KEYWORD_SOURCE_STATUS_LABELS[status]}
                {rowCount > 0 ? ` (${rowCount})` : ""}
                {fromCache ? " · cached" : ""}
                {reason ? ` · ${reason}` : ""}
              </li>
            ) : null,
        )}
      </ul>
      {servingProviders?.includes("gsc") && (
        <p className="mt-2 text-base-content/70">
          Search Console impressions count how often this property appeared in
          Google Search in the selected country.
        </p>
      )}
    </details>
  );
}
