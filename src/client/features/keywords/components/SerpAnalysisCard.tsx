/* eslint-disable eslint/max-lines */
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
} from "lucide-react";
import { ExportToSheetsButton } from "@/client/components/table/ExportToSheetsButton";
import { LOCATIONS } from "@/client/features/keywords/locations";
import type { SerpResultItem } from "@/types/keywords";
import { toSerpFeatureBlocks } from "@/server/features/serp/featurePresentation";
import type { SerpFeatureSet } from "@/server/features/serp/types";
import { SerpFeatureBlocks } from "./SerpFeatureBlocks";
import {
  SerpResultCards,
  type SerpResultCardRow,
} from "@/client/features/serp/SerpResultCards";

function formatSerpProviderLabel(provider?: string | null): string | null {
  if (!provider) return null;
  switch (provider.toLowerCase()) {
    case "serper":
      return "Serper.dev";
    case "zenserp":
      return "Zenserp";
    case "dataforseo":
      return "DataForSEO";
    case "internal":
      return "Stored Snapshot";
    case "cache":
      return "Cached";
    default:
      return provider;
  }
}

export function SerpAnalysisCard({
  items,
  features,
  keyword,
  loading,
  error,
  errorCorrelationId,
  status,
  unavailableReason,
  providerDiagnostics,
  provider,
  fetchedAt,
  fromCache,
  locationCode,
  languageCode,
  enrichmentAccountBlocked,
  onRetry,
  page,
  pageSize,
  onPageChange,
}: {
  items: SerpResultItem[];
  /** Normalized features observed in this analysis (spec 011, US1).
   *  Null/absent = none observed — no placeholder section renders. */
  features?: SerpFeatureSet | null;
  keyword?: string | null;
  loading: boolean;
  error?: string | null;
  errorCorrelationId?: string | null;
  status?: "ok" | "unavailable" | null;
  unavailableReason?: string | null;
  providerDiagnostics?: Array<{ provider: string; reason: string }> | null;
  provider?: string | null;
  fetchedAt?: string | null;
  fromCache?: boolean;
  locationCode?: number | null;
  languageCode?: string | null;
  enrichmentAccountBlocked?: "account_paused" | "billing" | null;
  onRetry?: () => void;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(items.length / pageSize);
  const pageItems = items.slice(page * pageSize, (page + 1) * pageSize);

  if (loading) return <SerpAnalysisLoadingState />;
  if (error) {
    return (
      <div
        className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error space-y-2"
        role="alert"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="font-medium text-base-content">
              SERP Analysis Failed
            </p>
            <p className="text-xs text-base-content/80 break-words">{error}</p>
            {errorCorrelationId && !error.includes(errorCorrelationId) ? (
              <p className="text-[11px] font-mono text-base-content/60">
                Reference: {errorCorrelationId}
              </p>
            ) : null}
          </div>
        </div>
        {onRetry ? (
          <button className="btn btn-xs" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (status === "unavailable") {
    return (
      <SerpAnalysisUnavailableState
        reason={unavailableReason}
        diagnostics={providerDiagnostics}
        onRetry={onRetry}
      />
    );
  }
  if (items.length === 0) return <SerpAnalysisEmptyState keyword={keyword} />;

  // Feature blocks derive from the stored/normalized feature set only.
  // Organic rows keep their stored ranks verbatim — features never displace
  // or renumber positions (spec 011, S9).
  const featureBlocks = features ? toSerpFeatureBlocks(features) : [];
  // Mobile card rows share the exact same rows + blocks (one data path, two
  // layouts — spec 011, R4). Cards show the current page slice, like the table.
  const cardRows: SerpResultCardRow[] = pageItems.map((item) => ({
    position: item.rank,
    title: item.title ?? "",
    url: item.url,
    domain: item.domain,
    summary: item.description || null,
    featureRefs: [],
    metrics: item.metricStatus
      ? {
          status: item.metricStatus,
          domainRank: item.domainRank ?? null,
          pageRank: item.pageRank ?? null,
          referringDomains: item.referringDomains ?? null,
          backlinks: item.backlinks ?? null,
          etv: item.etv ?? null,
          spamScore: item.spamScore ?? null,
          stale: item.stale ?? null,
          provider: item.provider ?? null,
          fetchedAt: item.fetchedAt ?? null,
        }
      : null,
  }));

  const providerLabel = formatSerpProviderLabel(provider);
  const locationLabel = locationCode
    ? (LOCATIONS[locationCode] ?? `Market ${locationCode}`)
    : null;
  const formattedFetchedAt = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div>
      {enrichmentAccountBlocked ? (
        <div className="alert alert-warning text-xs p-2 mb-3">
          <span>
            {enrichmentAccountBlocked === "account_paused"
              ? "Competitive metrics paused: provider account is paused. Base SERP results remain intact."
              : "Competitive metrics unavailable due to provider billing or credit exhaustion. Base SERP results remain intact."}
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
          <span>{items.length} organic results</span>
          {providerLabel ? (
            <span className="badge badge-ghost badge-xs">
              {providerLabel}
              {fromCache ? " (cached)" : ""}
            </span>
          ) : null}
          {locationLabel ? (
            <span className="badge badge-outline badge-xs">
              {locationLabel}
              {languageCode ? ` · ${languageCode.toUpperCase()}` : ""}
            </span>
          ) : null}
          {formattedFetchedAt ? (
            <span
              className="text-[11px] text-base-content/45"
              title={fetchedAt ?? undefined}
            >
              Updated {formattedFetchedAt}
            </span>
          ) : null}
        </div>
        <ExportToSheetsButton
          headers={["Rank", "Title", "URL", "Domain"]}
          rows={items.map((item) => [
            item.rank,
            item.title ?? "",
            item.url,
            item.domain,
          ])}
          feature="serp_analysis"
        />
      </div>
      {/* Desktop: dense table + feature sections. Mobile (below md): card
          view in place of the table (spec 011, S9 UI). */}
      <div className="hidden md:block">
        <SerpAnalysisTable items={pageItems} />
        <SerpFeatureBlocks blocks={featureBlocks} />
      </div>
      <div className="md:hidden">
        <SerpResultCards rows={cardRows} blocks={featureBlocks} />
      </div>
      <SerpAnalysisPagination
        page={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />
    </div>
  );
}

function SerpAnalysisTable({ items }: { items: SerpResultItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-xs w-full">
        <thead>
          <tr className="text-xs text-base-content/60">
            <th className="w-8">#</th>
            <th>Page</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={`${item.rank}-${item.url}`}
              className="hover:bg-base-200/50"
            >
              <td className="font-mono text-base-content/50 text-xs">
                {item.rank}
              </td>
              <td className="min-w-0 max-w-0">
                <div className="flex flex-col gap-0.5">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline truncate flex items-center gap-1"
                    title={item.title}
                  >
                    {item.title || item.url}
                    <ExternalLink className="size-3 shrink-0 opacity-40" />
                  </a>
                  <span className="text-xs text-base-content/40 truncate">
                    {item.domain}
                  </span>
                  {item.description ? (
                    <span className="text-xs text-base-content/60 line-clamp-2">
                      {item.description}
                    </span>
                  ) : null}
                  {item.metricStatus ? (
                    <CompetitorMetricsLine item={item} />
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Expanded competitor row (spec 007). Value semantics: an explicit provider
 * zero renders as 0; a missing metric renders as —; rows whose enrichment
 * failed or returned nothing carry an explicit status label. The base row
 * above always renders regardless of enrichment state.
 */
function CompetitorMetricsLine({ item }: { item: SerpResultItem }) {
  const providerTooltip = item.provider
    ? `Provider: ${item.provider}${item.fetchedAt ? ` (observed ${item.fetchedAt})` : ""}`
    : "DataForSEO competitive metrics";

  return (
    <span
      className="text-xs text-base-content/60 flex flex-wrap gap-x-3 gap-y-0.5"
      title={providerTooltip}
    >
      <span title="DataForSEO Domain Rank">
        DR {metricValue(item.domainRank)}
      </span>
      <span title="DataForSEO Page Rank">PR {metricValue(item.pageRank)}</span>
      <span title="Referring domains">
        Ref.domains {metricValue(item.referringDomains)}
      </span>
      <span title="Backlinks">Links {metricValue(item.backlinks)}</span>
      <span title="Provider-estimated traffic (not first-party analytics)">
        Est.traffic {metricValue(item.etv)}
      </span>
      {item.spamScore !== null && item.spamScore !== undefined ? (
        <span title="Backlinks Spam / Risk Score">
          Spam {metricValue(item.spamScore)}
        </span>
      ) : null}
      {item.stale ? (
        <span
          className="badge badge-warning badge-xs"
          title="Stale cache fallback after refresh failure"
        >
          stale
        </span>
      ) : null}
      {item.metricStatus !== "available" ? (
        <span className="text-warning">{item.metricStatus}</span>
      ) : null}
    </span>
  );
}

function metricValue(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function SerpAnalysisPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t border-base-200">
      <span className="text-xs text-base-content/50">
        Page {page + 1} of {totalPages}
      </span>
      <div className="flex gap-1">
        <button
          className="btn btn-ghost btn-xs"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
          Prev
        </button>
        <button
          className="btn btn-ghost btn-xs"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function SerpAnalysisLoadingState() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="h-8 rounded bg-base-200 animate-pulse"
          style={{ animationDelay: `${index * 50}ms` }}
        />
      ))}
    </div>
  );
}

function SerpAnalysisEmptyState({ keyword }: { keyword?: string | null }) {
  return (
    <div className="text-sm text-base-content/50 text-center py-8">
      <p>No SERP details available for this keyword yet.</p>
      {keyword ? (
        <p className="mt-1">Try clicking another keyword to load data.</p>
      ) : null}
    </div>
  );
}

function SerpAnalysisUnavailableState({
  reason,
  diagnostics,
  onRetry,
}: {
  reason?: string | null;
  diagnostics?: Array<{ provider: string; reason: string }> | null;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm space-y-2.5"
      data-testid="serp-unavailable-state"
      role="status"
    >
      <div className="flex items-start gap-2">
        <Info className="size-4 text-warning shrink-0 mt-0.5" />
        <div className="space-y-1.5 min-w-0">
          <p className="font-medium text-base-content">
            Live SERP Provider Not Configured
          </p>
          <p className="text-xs text-base-content/75">
            {reason ||
              "No live SERP provider is currently active. Configure Serper.dev or Zenserp in Settings to inspect live Google search results."}
          </p>
          {diagnostics && diagnostics.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {diagnostics.map((d) => (
                <span
                  key={d.provider}
                  className="badge badge-outline badge-xs font-mono text-[10px]"
                >
                  {d.provider}: {d.reason}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {onRetry ? (
        <button className="btn btn-xs btn-ghost" onClick={onRetry}>
          Check again
        </button>
      ) : null}
    </div>
  );
}
