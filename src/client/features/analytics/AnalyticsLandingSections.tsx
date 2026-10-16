import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import type {
  AnalyticsLandingResult,
  AnalyticsLandingRow,
} from "@/server/features/ga4/services/AnalyticsService";
import { canonicalUrl } from "@/shared/intelligence";
import { SectionError, SectionLoading, formatCount } from "./AnalyticsSections";
import { formatDelta, formatPctChange } from "./analyticsCopy";

function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function LandingPagesTable({
  projectId,
  rows,
  gscPages,
}: {
  projectId: string;
  rows: AnalyticsLandingRow[];
  gscPages?: Array<{ key: string; clicks: number; impressions: number }>;
}) {
  const gscByCanonical = useMemo(() => {
    if (!gscPages) return null;
    const hostContext =
      gscPages.find((gsc) => /^https?:\/\//i.test(gsc.key))?.key ?? null;
    const map = new Map<string, { clicks: number; impressions: number }>();
    for (const gsc of gscPages) {
      const canonical = canonicalUrl(gsc.key, hostContext);
      const existing = map.get(canonical) ?? { clicks: 0, impressions: 0 };
      existing.clicks += gsc.clicks;
      existing.impressions += gsc.impressions;
      map.set(canonical, existing);
    }
    return { map, hostContext };
  }, [gscPages]);

  if (rows.length === 0) {
    return (
      <div className="p-4 text-sm text-base-content/60">
        No landing pages in this period.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <caption className="sr-only">Landing pages</caption>
          <thead>
            <tr>
              <th>Page</th>
              <th className="text-right">Sessions</th>
              <th className="text-right">Change</th>
              <th className="text-right">Engagement rate</th>
              <th className="text-right">Page views</th>
              <th className="text-right">GSC clicks</th>
              <th className="text-right">GSC impressions</th>
              <th className="text-right">Corroborate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const canonicalPage = canonicalUrl(
                row.landingPage,
                gscByCanonical?.hostContext,
              );
              const gscEvidence = gscByCanonical?.map.get(canonicalPage);

              return (
                <tr key={row.landingPage}>
                  <td className="max-w-xs truncate" title={row.landingPage}>
                    {row.landingPage}
                  </td>
                  <td className="text-right">
                    {formatCount(row.sessions.current)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      row.sessions.change > 0
                        ? "text-success font-medium"
                        : row.sessions.change < 0
                          ? "text-error font-medium"
                          : "text-base-content/60"
                    }`}
                  >
                    {formatDelta(row.sessions.change)} (
                    {formatPctChange(row.sessions.pctChange)})
                  </td>
                  <td className="text-right tabular-nums">
                    {formatRatioAsPercent(row.engagementRate.current)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatCount(row.screenPageViews.current)}
                  </td>
                  <td className="text-right tabular-nums">
                    {gscEvidence ? (
                      formatCount(gscEvidence.clicks)
                    ) : (
                      <span
                        className="text-base-content/40"
                        title={
                          gscByCanonical === null
                            ? "GSC search data unavailable"
                            : "No matching GSC search clicks for this canonical URL"
                        }
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {gscEvidence ? (
                      formatCount(gscEvidence.impressions)
                    ) : (
                      <span
                        className="text-base-content/40"
                        title={
                          gscByCanonical === null
                            ? "GSC search data unavailable"
                            : "No matching GSC search impressions for this canonical URL"
                        }
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <Link
                      to="/p/$projectId/search-performance"
                      params={{ projectId }}
                      className="link link-hover text-xs"
                    >
                      GSC
                    </Link>{" "}
                    <Link
                      to="/p/$projectId/rank-tracking"
                      params={{ projectId }}
                      className="link link-hover text-xs"
                    >
                      Rank
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-base-content/60">
        GA4 landing pages and GSC search metrics correlate through canonical SEO
        URL identity. Differences between clicks and visits reflect attribution
        boundaries across search discovery and site sessions.
      </p>
    </div>
  );
}

export function LandingSection({
  projectId,
  result,
  gscPages,
  pending,
  queryError,
}: {
  projectId: string;
  result: AnalyticsLandingResult | undefined;
  gscPages?: Array<{ key: string; clicks: number; impressions: number }>;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="landing pages" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <LandingPagesTable
      projectId={projectId}
      rows={result.rows}
      gscPages={gscPages}
    />
  );
}
