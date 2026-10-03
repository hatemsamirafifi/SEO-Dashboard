/* Dashboard intelligence sections (spec 011, US3 — T023).
 *
 *  Renders the eight stored-rollup sections from getIntelligenceOverview
 *  through the shared SectionStateShell (one deterministic state vocabulary,
 *  spec 011 A2). Metrics children render ONLY in data states
 *  (ready/partial/stale); every other state renders its explicit honest UI.
 *  Purely presentational: data arrives via props from DashboardPage's
 *  overview query — no fetches here (P29). Plain anchors (no router context)
 *  so sections stay unit-testable. */
import {
  CardShell,
  SectionStateShell,
  Stat,
  formatDay,
  type SectionStateKind,
} from "@/client/features/dashboard/cardParts";
import type {
  DashboardIntelligenceSections,
  OverviewSection,
} from "@/server/features/dashboard/services/DashboardService";
import type { PeriodDelta } from "@/shared/intelligence";

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
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

function DeltaStat({
  label,
  delta,
  format = formatInt,
}: {
  label: string;
  delta: PeriodDelta;
  format?: (value: number) => string;
}) {
  return (
    <Stat
      label={label}
      value={format(delta.current)}
      sub={
        <span className="text-xs text-base-content/50">
          {formatChange(delta)}
        </span>
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
      <Section
        title="Search performance"
        section={sections.seoPerformance}
        emptyMessage="Search Console synced, but no clicks or impressions in this window."
        noDataMessage="No Search Console data synced for this window yet."
        notConnectedMessage="Connect Search Console to see search performance."
        detailsHref={p("/search-performance")}
        detailsLabel="Open GSC Insights"
        onRetry={onRetry}
      >
        {sections.seoPerformance.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <DeltaStat
              label="Clicks"
              delta={sections.seoPerformance.metrics.clicks}
            />
            <DeltaStat
              label="Impressions"
              delta={sections.seoPerformance.metrics.impressions}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Search visibility"
        section={sections.searchVisibility}
        emptyMessage="Rank checks ran, but none of the tracked keywords rank yet."
        noDataMessage="No rank checks have completed yet."
        notConnectedMessage="Set up rank tracking to see search visibility."
        detailsHref={p("/rank-tracking")}
        detailsLabel="Open Rank Tracking"
        onRetry={onRetry}
      >
        {sections.searchVisibility.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Top 3"
              value={formatInt(sections.searchVisibility.metrics.top3.current)}
            />
            <Stat
              label="Top 10"
              value={formatInt(sections.searchVisibility.metrics.top10.current)}
            />
            <Stat
              label="Tracked keywords"
              value={formatInt(
                sections.searchVisibility.metrics.trackedKeywords,
              )}
            />
            <Stat
              label="Improved / declined"
              value={`${sections.searchVisibility.metrics.improved} / ${sections.searchVisibility.metrics.declined}`}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Traffic & engagement"
        section={sections.trafficEngagement}
        emptyMessage="Analytics synced, but no sessions in this window."
        noDataMessage="No Analytics data synced for this window yet."
        notConnectedMessage="Connect Google Analytics to see traffic and engagement."
        detailsHref={p("/analytics")}
        detailsLabel="Open Analytics"
        onRetry={onRetry}
      >
        {sections.trafficEngagement.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <DeltaStat
              label="Sessions"
              delta={sections.trafficEngagement.metrics.sessions}
            />
            <DeltaStat
              label="Engaged sessions"
              delta={sections.trafficEngagement.metrics.engagedSessions}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Conversions"
        section={sections.conversions}
        emptyMessage="Analytics synced, but no conversions in this window."
        noDataMessage="No conversion data synced for this window yet."
        notConnectedMessage="Connect Google Analytics to see conversions."
        detailsHref={p("/analytics")}
        detailsLabel="Open Analytics"
        onRetry={onRetry}
      >
        {sections.conversions.metrics ? (
          <ul className="flex flex-col gap-1">
            {sections.conversions.metrics.keyEvents.map((row) => (
              <li
                key={row.name}
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="truncate">{row.name}</span>
                <span className="font-semibold tabular-nums">
                  {formatInt(row.count.current)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Opportunities"
        section={sections.opportunities}
        emptyMessage="No open opportunities right now. New findings appear after each scan."
        noDataMessage="No intelligence scan has completed yet."
        notConnectedMessage="Opportunities appear after the first intelligence scan."
        detailsHref={p("/opportunities")}
        detailsLabel="Open Opportunities"
        onRetry={onRetry}
      >
        {sections.opportunities.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Open"
              value={formatInt(sections.opportunities.metrics.openTotal)}
            />
            <Stat
              label="Critical"
              value={formatInt(sections.opportunities.metrics.critical)}
            />
            <Stat
              label="High"
              value={formatInt(sections.opportunities.metrics.high)}
            />
            <Stat
              label="Medium"
              value={formatInt(sections.opportunities.metrics.medium)}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Technical health"
        section={sections.technicalHealth}
        emptyMessage="The latest audit found no pages to report on."
        noDataMessage="No site audit has completed yet."
        notConnectedMessage="Run a site audit to see technical health."
        detailsHref={p("/audit")}
        detailsLabel="Open Site Audit"
        onRetry={onRetry}
      >
        {sections.technicalHealth.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Pages crawled"
              value={formatInt(sections.technicalHealth.metrics.pagesCrawled)}
            />
            <Stat
              label="Last audit"
              value={formatDay(sections.technicalHealth.metrics.lastAuditAt)}
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Backlinks"
        section={sections.backlinks}
        emptyMessage="The latest snapshot recorded no backlinks for this domain."
        noDataMessage="No backlink snapshot has been captured for this domain yet."
        notConnectedMessage="Backlink snapshots appear after the first capture."
        detailsHref={p("/backlinks")}
        detailsLabel="Open Backlinks"
        onRetry={onRetry}
      >
        {sections.backlinks.metrics ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Backlinks"
              value={
                sections.backlinks.metrics.backlinks === null
                  ? "—"
                  : formatInt(sections.backlinks.metrics.backlinks)
              }
            />
            <Stat
              label="Referring domains"
              value={
                sections.backlinks.metrics.referringDomains === null
                  ? "—"
                  : formatInt(sections.backlinks.metrics.referringDomains)
              }
            />
          </div>
        ) : null}
      </Section>

      <Section
        title="Recent changes"
        section={sections.recentChanges}
        emptyMessage="No new findings in the latest scan."
        noDataMessage="No intelligence scan has produced findings yet."
        notConnectedMessage="Recent changes appear after the first intelligence scan."
        detailsHref={p("/opportunities")}
        detailsLabel="Open Opportunities"
        onRetry={onRetry}
      >
        {sections.recentChanges.metrics ? (
          <ul className="flex flex-col gap-2">
            {sections.recentChanges.metrics.items.map((item) => (
              <li key={item.title} className="text-sm">
                <p className="font-medium">{item.title}</p>
                <p className="text-xs text-base-content/60">{item.fact}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}
