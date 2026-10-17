/* eslint-disable max-lines */
/* Dashboard intelligence sections (spec 011, US3 — T023).
 *
 *  Renders the eight stored-rollup sections from getIntelligenceOverview
 *  through the shared SectionStateShell (one deterministic state vocabulary,
 *  spec 011 A2). Metrics children render ONLY in data states
 *  (ready/partial/stale); every other state renders its explicit honest UI.
 *  Purely presentational: data arrives via props from DashboardPage's
 *  overview query — no fetches here (P29). Plain anchors (no router context)
 *  so sections stay unit-testable. */
import { Check } from "lucide-react";
import { SourceBadge } from "@/client/components/SourceBadge";
import {
  CardShell,
  SectionStateShell,
  Stat,
  formatDay,
  newLost,
  type SectionStateKind,
} from "@/client/features/dashboard/cardParts";
import {
  severityBadgeClass,
  severityLabel,
} from "@/client/features/insights/insightsCopy";
import type {
  BacklinksMetrics,
  ConversionsMetrics,
  DashboardIntelligenceSections,
  OpportunitiesMetrics,
  OverviewSection,
  RecentChangesMetrics,
  SearchVisibilityMetrics,
  SeoPerformanceMetrics,
  TechnicalHealthMetrics,
  TrafficEngagementMetrics,
} from "@/server/features/dashboard/services/DashboardService";
import { AUDIT_ISSUE_TYPES } from "@/shared/audit-issues";
import type { CoverageNote, PeriodDelta } from "@/shared/intelligence";

const issueTitles: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(AUDIT_ISSUE_TYPES).map(([key, value]) => [key, value.title]),
);

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatPosition(value: number): string {
  return value.toFixed(1);
}

function formatChange(delta: PeriodDelta): string | null {
  if (delta.change === null) return "no prior data";
  const sign = delta.change > 0 ? "+" : delta.change < 0 ? "−" : "";
  const pct =
    delta.changePct === null
      ? ""
      : ` (${sign}${Math.abs(Math.round(delta.changePct))}%)`;
  return `${sign}${formatInt(Math.abs(delta.change))}${pct}`;
}

function formatPercentChange(delta: PeriodDelta): string | null {
  if (delta.change === null) return "no prior data";
  const sign = delta.change > 0 ? "+" : delta.change < 0 ? "−" : "";
  const pts = `${(Math.abs(delta.change) * 100).toFixed(1)}%`;
  const pct =
    delta.changePct === null
      ? ""
      : ` (${sign}${Math.abs(Math.round(delta.changePct))}%)`;
  return `${sign}${pts}${pct}`;
}

function formatPositionChange(delta: PeriodDelta): string | null {
  if (delta.change === null) return "no prior data";
  const sign = delta.change > 0 ? "+" : delta.change < 0 ? "−" : "";
  const diff = Math.abs(delta.change).toFixed(1);
  const status =
    delta.change < 0 ? "improved" : delta.change > 0 ? "declined" : "steady";
  return `${sign}${diff} (${status})`;
}

function DeltaStat({
  label,
  delta,
  format = formatInt,
  formatSub = formatChange,
}: {
  label: string;
  delta: PeriodDelta;
  format?: (value: number) => string;
  formatSub?: (delta: PeriodDelta) => string | null;
}) {
  return (
    <Stat
      label={label}
      value={format(delta.current)}
      sub={
        <span className="text-xs text-base-content/50">{formatSub(delta)}</span>
      }
    />
  );
}

function DetailsLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="btn btn-ghost btn-xs">
      {label}
    </a>
  );
}

function formatCoverageStamp(coverage: CoverageNote): string {
  const sourceLabels: Record<CoverageNote["source"], string> = {
    gsc: "Search Console · last 28 days",
    ga4: "Google Analytics · last 28 days",
    rank: "Rank tracking",
    opportunities: "Stored opportunities",
    insights: "Recent insights",
    audit: "Site audit",
    backlinks: "Backlink pulse",
  };
  const base = sourceLabels[coverage.source] ?? coverage.source;
  if (coverage.freshness) {
    return `${base} · updated ${formatDay(coverage.freshness)}`;
  }
  return base;
}

function Section({
  title,
  section,
  emptyMessage,
  noDataMessage,
  notConnectedMessage,
  detailsHref,
  detailsLabel,
  onRetry,
  children,
}: {
  title: string;
  section: OverviewSection<unknown>;
  emptyMessage: string;
  noDataMessage: string;
  notConnectedMessage: string;
  detailsHref: string;
  detailsLabel: string;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  return (
    <CardShell
      title={title}
      stamp={formatCoverageStamp(section.coverage)}
      action={<DetailsLink href={detailsHref} label={detailsLabel} />}
    >
      <SectionStateShell
        state={section.state as SectionStateKind}
        detail={section.coverage.detail}
        freshness={section.coverage.freshness}
        emptyMessage={emptyMessage}
        noDataMessage={noDataMessage}
        notConnectedMessage={notConnectedMessage}
        notConnectedCta={
          <DetailsLink href={detailsHref} label={detailsLabel} />
        }
        onRetry={onRetry}
      >
        {children}
      </SectionStateShell>
    </CardShell>
  );
}

function SeoPerformanceSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<SeoPerformanceMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  return (
    <Section
      title="Search performance"
      section={section}
      emptyMessage="Search Console synced, but no clicks or impressions in this window."
      noDataMessage="No Search Console data synced for this window yet."
      notConnectedMessage="Connect Search Console to see search performance."
      detailsHref={href}
      detailsLabel="Open GSC Insights"
      onRetry={onRetry}
    >
      {section.metrics ? (
        <div className="grid grid-cols-2 gap-3">
          <DeltaStat label="Clicks" delta={section.metrics.clicks} />
          <DeltaStat label="Impressions" delta={section.metrics.impressions} />
          <DeltaStat
            label="CTR"
            delta={section.metrics.ctr}
            format={formatPercent}
            formatSub={formatPercentChange}
          />
          <DeltaStat
            label="Avg position"
            delta={section.metrics.avgPosition}
            format={formatPosition}
            formatSub={formatPositionChange}
          />
        </div>
      ) : null}
    </Section>
  );
}

function SearchVisibilitySection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<SearchVisibilityMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  return (
    <Section
      title="Search visibility"
      section={section}
      emptyMessage="Rank checks ran, but none of the tracked keywords rank yet."
      noDataMessage="No rank checks have completed yet."
      notConnectedMessage="Set up rank tracking to see search visibility."
      detailsHref={href}
      detailsLabel="Open Rank Tracking"
      onRetry={onRetry}
    >
      {section.metrics ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Top 3"
              value={formatInt(section.metrics.top3.current)}
            />
            <Stat
              label="Top 10"
              value={formatInt(section.metrics.top10.current)}
            />
            <Stat
              label="Top 100"
              value={formatInt(section.metrics.top100.current)}
            />
            <Stat
              label="Tracked keywords"
              value={formatInt(section.metrics.trackedKeywords)}
            />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-base-200 pt-3 text-xs">
            <span className="text-base-content/60">Ranking movements:</span>
            <span className="font-medium tabular-nums">
              <span className="text-success">
                ▲ {section.metrics.improved} improved
              </span>
              {" · "}
              <span className="text-error">
                ▼ {section.metrics.declined} declined
              </span>
            </span>
          </div>
        </>
      ) : null}
    </Section>
  );
}

function TrafficEngagementSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<TrafficEngagementMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  return (
    <Section
      title="Traffic & engagement"
      section={section}
      emptyMessage="Analytics synced, but no sessions in this window."
      noDataMessage="No Analytics data synced for this window yet."
      notConnectedMessage="Connect Google Analytics to see traffic and engagement."
      detailsHref={href}
      detailsLabel="Open Analytics"
      onRetry={onRetry}
    >
      {section.metrics ? (
        <div className="grid grid-cols-2 gap-3">
          <DeltaStat label="Sessions" delta={section.metrics.sessions} />
          <DeltaStat
            label="Organic sessions"
            delta={section.metrics.organicSessions}
          />
          <DeltaStat
            label="Engaged sessions"
            delta={section.metrics.engagedSessions}
          />
          <DeltaStat
            label="Engagement rate"
            delta={section.metrics.engagementRate}
            format={formatPercent}
            formatSub={formatPercentChange}
          />
        </div>
      ) : null}
    </Section>
  );
}

function ConversionsSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<ConversionsMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  const metrics = section.metrics;
  const hasTransactions =
    metrics?.transactions != null &&
    (metrics.transactions.current > 0 ||
      metrics.transactions.previous !== null);
  return (
    <Section
      title="Conversions"
      section={section}
      emptyMessage="Analytics synced, but no conversions in this window."
      noDataMessage="No conversion data synced for this window yet."
      notConnectedMessage="Connect Google Analytics to see conversions."
      detailsHref={href}
      detailsLabel="Open Analytics"
      onRetry={onRetry}
    >
      {metrics ? (
        <>
          {hasTransactions ? (
            <div className="mb-3 border-b border-base-200 pb-2">
              <DeltaStat label="Transactions" delta={metrics.transactions} />
            </div>
          ) : null}
          {metrics.keyEvents.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {metrics.keyEvents.map((row) => (
                <li
                  key={row.name}
                  className="flex items-baseline justify-between gap-2 text-sm"
                >
                  <span className="truncate">{row.name}</span>
                  <span className="shrink-0 text-right">
                    <span className="font-semibold tabular-nums">
                      {formatInt(row.count.current)}
                    </span>
                    <span className="ml-2 text-xs text-base-content/50">
                      {formatChange(row.count)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-base-content/60">
              No key events recorded in this window.
            </p>
          )}
        </>
      ) : null}
    </Section>
  );
}

function OpportunitiesSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<OpportunitiesMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  return (
    <Section
      title="Opportunities"
      section={section}
      emptyMessage="No open opportunities right now. New findings appear after each scan."
      noDataMessage="No intelligence scan has completed yet."
      notConnectedMessage="Opportunities appear after the first intelligence scan."
      detailsHref={href}
      detailsLabel="Open Opportunities"
      onRetry={onRetry}
    >
      {section.metrics ? (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Open" value={formatInt(section.metrics.openTotal)} />
          <Stat
            label="Critical"
            value={formatInt(section.metrics.critical)}
            tone={section.metrics.critical > 0 ? "error" : undefined}
          />
          <Stat
            label="High"
            value={formatInt(section.metrics.high)}
            tone={section.metrics.high > 0 ? "error" : undefined}
          />
          <Stat label="Medium" value={formatInt(section.metrics.medium)} />
        </div>
      ) : null}
    </Section>
  );
}

function TechnicalHealthSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<TechnicalHealthMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  const metrics = section.metrics;
  return (
    <Section
      title="Technical health"
      section={section}
      emptyMessage="The latest audit found no pages to report on."
      noDataMessage="No site audit has completed yet."
      notConnectedMessage="Run a site audit to see technical health."
      detailsHref={href}
      detailsLabel="Open Site Audit"
      onRetry={onRetry}
    >
      {metrics ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Pages crawled"
              value={formatInt(metrics.pagesCrawled)}
            />
            <Stat label="Last audit" value={formatDay(metrics.lastAuditAt)} />
          </div>
          {metrics.topIssues && metrics.topIssues.length > 0 ? (
            <ul className="mt-3 space-y-1.5 border-t border-base-200 pt-3">
              {metrics.topIssues.map((issue) => (
                <li
                  key={issue.issueType}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        issue.severity === "critical"
                          ? "bg-error"
                          : issue.severity === "warning"
                            ? "bg-warning"
                            : "bg-base-content/30"
                      }`}
                    />
                    <span className="truncate">
                      {issueTitles[issue.issueType] ?? issue.issueType}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-base-content/60">
                    {issue.count} {issue.count === 1 ? "page" : "pages"}
                  </span>
                </li>
              ))}
              {metrics.totalIssueTypes > metrics.topIssues.length ? (
                <li className="text-[11px] text-base-content/50">
                  + {metrics.totalIssueTypes - metrics.topIssues.length} more{" "}
                  issue
                  {metrics.totalIssueTypes - metrics.topIssues.length === 1
                    ? ""
                    : "s"}
                </li>
              ) : null}
            </ul>
          ) : metrics.status === "completed" && metrics.pagesCrawled > 0 ? (
            <div className="mt-3 flex items-center gap-1.5 border-t border-base-200 pt-3 text-xs text-success">
              <Check className="size-3.5" />
              No issues found — your site looks healthy.
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function BacklinksSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<BacklinksMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  const metrics = section.metrics;
  return (
    <Section
      title="Backlinks"
      section={section}
      emptyMessage="The latest snapshot recorded no backlinks for this domain."
      noDataMessage="No backlink snapshot has been captured for this domain yet."
      notConnectedMessage="Backlink snapshots appear after the first capture."
      detailsHref={href}
      detailsLabel="Open Backlinks"
      onRetry={onRetry}
    >
      {metrics ? (
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Backlinks"
            value={
              metrics.backlinks === null ? "—" : formatInt(metrics.backlinks)
            }
          />
          <Stat
            label="Referring domains"
            value={
              metrics.referringDomains === null
                ? "—"
                : formatInt(metrics.referringDomains)
            }
          />
          <Stat
            label="New links"
            value={`▲ ${newLost(metrics.newBacklinks)}`}
            tone={
              metrics.newBacklinks && metrics.newBacklinks > 0
                ? "success"
                : undefined
            }
          />
          <Stat
            label="Lost links"
            value={`▼ ${newLost(metrics.lostBacklinks)}`}
            tone={
              metrics.lostBacklinks && metrics.lostBacklinks > 0
                ? "error"
                : undefined
            }
          />
        </div>
      ) : null}
    </Section>
  );
}

function RecentChangesSection({
  section,
  href,
  onRetry,
}: {
  section: OverviewSection<RecentChangesMetrics>;
  href: string;
  onRetry?: () => void;
}) {
  return (
    <Section
      title="Recent changes"
      section={section}
      emptyMessage="No new findings in the latest scan."
      noDataMessage="No intelligence scan has produced findings yet."
      notConnectedMessage="Recent changes appear after the first intelligence scan."
      detailsHref={href}
      detailsLabel="Open Opportunities"
      onRetry={onRetry}
    >
      {section.metrics ? (
        <ul className="flex flex-col gap-2.5">
          {section.metrics.items.map((item) => (
            <li
              key={item.title}
              className="rounded-lg border border-base-200 bg-base-100 p-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={severityBadgeClass(item.severity)}>
                  {severityLabel(item.severity)}
                </span>
                {item.sources.map((src) => (
                  <SourceBadge key={src} source={src} />
                ))}
                <span className="ml-auto text-[11px] text-base-content/50">
                  {formatDay(item.detectedAt)}
                </span>
              </div>
              <p className="mt-1.5 font-medium leading-snug">{item.title}</p>
              <p className="mt-1 text-xs text-base-content/70">{item.fact}</p>
              {item.recommendation ? (
                <div className="mt-2 rounded bg-base-200/50 p-2 text-xs text-base-content/80">
                  <span className="font-semibold text-primary">
                    Recommendation:
                  </span>{" "}
                  {item.recommendation}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

export function IntelligenceSections({
  projectId,
  sections,
  onRetry,
}: {
  projectId: string;
  sections: DashboardIntelligenceSections;
  onRetry?: () => void;
}) {
  const p = (rest: string) => `/p/${projectId}${rest}`;
  return (
    <>
      <SeoPerformanceSection
        section={sections.seoPerformance}
        href={p("/search-performance")}
        onRetry={onRetry}
      />
      <SearchVisibilitySection
        section={sections.searchVisibility}
        href={p("/rank-tracking")}
        onRetry={onRetry}
      />
      <TrafficEngagementSection
        section={sections.trafficEngagement}
        href={p("/analytics")}
        onRetry={onRetry}
      />
      <ConversionsSection
        section={sections.conversions}
        href={p("/analytics")}
        onRetry={onRetry}
      />
      <OpportunitiesSection
        section={sections.opportunities}
        href={p("/opportunities")}
        onRetry={onRetry}
      />
      <TechnicalHealthSection
        section={sections.technicalHealth}
        href={p("/audit")}
        onRetry={onRetry}
      />
      <BacklinksSection
        section={sections.backlinks}
        href={p("/backlinks")}
        onRetry={onRetry}
      />
      <RecentChangesSection
        section={sections.recentChanges}
        href={p("/opportunities")}
        onRetry={onRetry}
      />
    </>
  );
}
