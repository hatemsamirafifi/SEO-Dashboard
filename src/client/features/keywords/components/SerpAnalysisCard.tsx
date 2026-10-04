import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { ExportToSheetsButton } from "@/client/components/table/ExportToSheetsButton";
import type { SerpResultItem } from "@/types/keywords";
import { toSerpFeatureBlocks } from "@/server/features/serp/featurePresentation";
import type { SerpFeatureSet } from "@/server/features/serp/types";
import { SerpFeatureBlocks } from "./SerpFeatureBlocks";
import {
  SerpResultCards,
  type SerpResultCardRow,
} from "@/client/features/serp/SerpResultCards";

export function SerpAnalysisCard({
  items,
  features,
  keyword,
  loading,
  error,
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
      <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error space-y-2">
        <p>{error}</p>
        {onRetry ? (
          <button className="btn btn-xs" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
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
        }
      : null,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-base-content/50">
          {items.length} organic results
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
  return (
    <span className="text-xs text-base-content/60 flex flex-wrap gap-x-3 gap-y-0.5">
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
