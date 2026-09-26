import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type {
  AnalyticsAcquisitionResult,
  AnalyticsAudienceResult,
  AnalyticsConversionsResult,
  AnalyticsEventsResult,
  AnalyticsLandingResult,
  AnalyticsAcquisitionRow,
  AnalyticsLandingRow,
  AnalyticsOverviewResult,
  MetricDelta,
} from "@/server/features/ga4/services/AnalyticsService";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { coverageBadge, formatDelta, formatPctChange } from "./analyticsCopy";

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function DeltaLine({
  delta,
  format,
}: {
  delta: MetricDelta;
  format: (value: number) => string;
}) {
  return (
    <span className="block text-xs text-base-content/60">
      {format(delta.current)} ({formatDelta(delta.change)},{" "}
      {formatPctChange(delta.pctChange)})
    </span>
  );
}

export function StatCard({
  label,
  delta,
  format,
  footnote,
}: {
  label: string;
  delta: MetricDelta;
  format: (value: number) => string;
  footnote?: string;
}) {
  return (
    <div className="stat rounded-xl border border-base-300 bg-base-100 px-4 py-3">
      <div className="stat-title text-xs">{label}</div>
      <div className="stat-value text-2xl">{format(delta.current)}</div>
      <div className="stat-desc">
        <DeltaLine delta={delta} format={format} />
        {footnote ? <span className="block">{footnote}</span> : null}
      </div>
    </div>
  );
}

export function OverviewCards({
  overview,
}: {
  overview: Extract<AnalyticsOverviewResult, { connected: true }>;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Sessions"
          delta={overview.totals.sessions}
          format={formatCount}
        />
        <StatCard
          label="Engagement rate"
          delta={overview.totals.engagementRate}
          format={formatRatioAsPercent}
        />
        <StatCard
          label="Avg engagement time"
          delta={overview.totals.avgEngagementTimePerSession}
          format={formatSeconds}
        />
        <StatCard
          label="Page views"
          delta={overview.totals.screenPageViews}
          format={formatCount}
        />
        <StatCard
          label="Events"
          delta={overview.totals.eventCount}
          format={formatCount}
        />
        <StatCard
          label="New users"
          delta={overview.totals.newUsers}
          format={formatCount}
          footnote="New on each day"
        />
      </div>
      <p className="mt-2 text-xs text-base-content/60">
        {overview.newUsersFootnote} {overview.currencyNote}
      </p>
    </div>
  );
}

export function AcquisitionTable({
  rows,
  title,
  emptyNote,
}: {
  rows: AnalyticsAcquisitionRow[];
  title: string;
  emptyNote: string;
}) {
  if (rows.length === 0) {
    return <div className="p-4 text-sm text-base-content/60">{emptyNote}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Source / Medium</th>
            <th className="text-right">Sessions</th>
            <th className="text-right">Change</th>
            <th className="text-right">Engagement rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.channelGroup}\n${row.source}\n${row.medium}`}>
              <td>
                {row.channelGroup}{" "}
                {row.isOrganic ? (
                  <span className="badge badge-primary badge-xs">Organic</span>
                ) : null}
              </td>
              <td className="text-base-content/70">
                {row.source} / {row.medium}
              </td>
              <td className="text-right">
                {formatCount(row.sessions.current)}
              </td>
              <td className="text-right">
                {formatDelta(row.sessions.change)} (
                {formatPctChange(row.sessions.pctChange)})
              </td>
              <td className="text-right">
                {formatRatioAsPercent(row.engagementRate.current)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LandingPagesTable({
  projectId,
  rows,
}: {
  projectId: string;
  rows: AnalyticsLandingRow[];
}) {
  if (rows.length === 0) {
    return (
      <div className="p-4 text-sm text-base-content/60">
        No landing pages in this period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <caption className="sr-only">Landing pages</caption>
        <thead>
          <tr>
            <th>Page</th>
            <th className="text-right">Sessions</th>
            <th className="text-right">Change</th>
            <th className="text-right">Corroborate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.landingPage}>
              <td className="max-w-xs truncate" title={row.landingPage}>
                {row.landingPage}
              </td>
              <td className="text-right">
                {formatCount(row.sessions.current)}
              </td>
              <td className="text-right">
                {formatDelta(row.sessions.change)} (
                {formatPctChange(row.sessions.pctChange)})
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SectionLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-base-content/60">
      <Loader2 className="size-4 animate-spin" /> Loading {label}…
    </div>
  );
}

export function SectionError({ error }: { error: unknown }) {
  return (
    <div className="alert alert-error">
      <span className="text-sm">{getStandardErrorMessage(error)}</span>
    </div>
  );
}

export function OverviewSection({
  result,
  pending,
  queryError,
}: {
  result: AnalyticsOverviewResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="overview" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <>
      <OverviewCards overview={result} />
      {result.reservedFilterNote ? (
        <p className="mt-2 text-xs text-base-content/60">
          {result.reservedFilterNote}
        </p>
      ) : null}
    </>
  );
}

export function AcquisitionSection({
  result,
  pending,
  queryError,
  title,
  emptyNote,
}: {
  result: AnalyticsAcquisitionResult | undefined;
  pending: boolean;
  queryError: unknown;
  title: string;
  emptyNote: string;
}) {
  if (pending) return <SectionLoading label={title.toLowerCase()} />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <AcquisitionTable rows={result.rows} title={title} emptyNote={emptyNote} />
  );
}

export function LandingSection({
  projectId,
  result,
  pending,
  queryError,
}: {
  projectId: string;
  result: AnalyticsLandingResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="landing pages" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return <LandingPagesTable projectId={projectId} rows={result.rows} />;
}

type CoveragedAnalyticsResult =
  | AnalyticsOverviewResult
  | AnalyticsEventsResult
  | AnalyticsConversionsResult
  | AnalyticsAudienceResult;

export function CoverageBadge({
  result,
}: {
  result: CoveragedAnalyticsResult | undefined;
}) {
  if (!result || !result.connected) return null;
  return (
    <span className="badge badge-ghost badge-sm">
      {coverageBadge(result.coverage)}
    </span>
  );
}
