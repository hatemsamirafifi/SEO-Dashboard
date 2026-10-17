import { consistencyBanner, type ReportPayload } from "@/shared/reports";
import {
  priorityBadgeClass,
  priorityLabel,
  statusBadgeClass,
  statusLabel,
} from "@/client/features/opportunities/opportunitiesCopy";
import {
  availabilityNote,
  formatDateTime,
  SECTION_TITLES,
} from "@/client/features/reports/reportsCopy";

// Shared snapshot rendering for the private detail page and the public
// `r/$token` page (identical sections, identical banner string).

export function severityBadgeClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "badge badge-error badge-sm";
    case "high":
      return "badge badge-warning badge-sm";
    case "medium":
      return "badge badge-info badge-sm";
    default:
      return "badge badge-ghost badge-sm";
  }
}

function MetricCard({
  label,
  value,
  previousValue,
}: {
  label: string;
  value: string;
  previousValue?: string | null;
}) {
  return (
    <div className="rounded-lg border border-base-300 p-3">
      <div className="text-xs text-base-content/60">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {previousValue ? (
        <div className="text-xs text-base-content/50">
          prev: {previousValue}
        </div>
      ) : null}
    </div>
  );
}

function SectionShell({
  title,
  status,
  children,
}: {
  title: string;
  status: { available: boolean; reason: string | null };
  children?: React.ReactNode;
}) {
  const note = status.available ? null : availabilityNote(status.reason);
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <h2 className="font-semibold">{title}</h2>
      {note ? (
        <p className="mt-2 text-sm text-base-content/60">{note}</p>
      ) : (
        <div className="mt-3">{children}</div>
      )}
    </section>
  );
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export { BrandedReportHeader } from "./BrandedReportHeader";

export function ConsistencyBanner({ payload }: { payload: ReportPayload }) {
  const concurrent =
    payload.provenance.consistencyStatus === "concurrent_mutation";
  return (
    <div className={concurrent ? "alert alert-warning" : "alert alert-info"}>
      {consistencyBanner(payload.provenance)}
    </div>
  );
}

export function ProvenanceBlock({ payload }: { payload: ReportPayload }) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
      <p>Generated {formatDateTime(payload.generatedAt)}</p>
      {payload.provenance.hasSuccessfulScan ? (
        <p>
          Intelligence from scan{" "}
          {payload.provenance.intelligenceRunId?.slice(0, 8)}
          {payload.provenance.intelligenceStale ? " (stale)" : ""}
          {payload.provenance.intelligenceCompletedAt
            ? ` — completed ${formatDateTime(payload.provenance.intelligenceCompletedAt)}`
            : ""}
        </p>
      ) : (
        <p>No successful intelligence scan at generation time.</p>
      )}
    </section>
  );
}

function SearchVisibilitySection({ payload }: { payload: ReportPayload }) {
  const totals = payload.searchVisibility.totals;
  const prev = payload.searchVisibility.previousTotals;
  return (
    <SectionShell
      title={SECTION_TITLES.search_visibility}
      status={payload.searchVisibility.status}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Clicks"
          value={String(totals?.clicks ?? "—")}
          previousValue={prev ? String(prev.clicks) : null}
        />
        <MetricCard
          label="Impressions"
          value={String(totals?.impressions ?? "—")}
          previousValue={prev ? String(prev.impressions) : null}
        />
        <MetricCard
          label="CTR"
          value={totals ? formatPercent(totals.ctr) : "—"}
          previousValue={prev ? formatPercent(prev.ctr) : null}
        />
        <MetricCard
          label="Avg. position"
          value={totals ? totals.position.toFixed(1) : "—"}
          previousValue={prev ? prev.position.toFixed(1) : null}
        />
      </div>
    </SectionShell>
  );
}

function TrafficSection({ payload }: { payload: ReportPayload }) {
  const totals = payload.traffic.totals;
  const prev = payload.traffic.previousTotals;
  return (
    <SectionShell
      title={SECTION_TITLES.traffic}
      status={payload.traffic.status}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Sessions"
          value={String(totals?.sessions ?? "—")}
          previousValue={prev ? String(prev.sessions) : null}
        />
        <MetricCard
          label="Engaged sessions"
          value={String(totals?.engagedSessions ?? "—")}
          previousValue={prev ? String(prev.engagedSessions) : null}
        />
        <MetricCard
          label="Page views"
          value={String(totals?.screenPageViews ?? "—")}
          previousValue={prev ? String(prev.screenPageViews) : null}
        />
        <MetricCard
          label="New users"
          value={String(totals?.newUsers ?? "—")}
          previousValue={prev ? String(prev.newUsers) : null}
        />
      </div>
    </SectionShell>
  );
}

function ConversionsSection({ payload }: { payload: ReportPayload }) {
  return (
    <SectionShell
      title={SECTION_TITLES.conversions}
      status={payload.conversions.status}
    >
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="Key events"
          value={String(payload.conversions.keyEvents ?? "—")}
        />
        <MetricCard
          label="Transactions"
          value={String(payload.conversions.transactions ?? "—")}
        />
      </div>
    </SectionShell>
  );
}

function RankingsSection({ payload }: { payload: ReportPayload }) {
  return (
    <SectionShell
      title={SECTION_TITLES.rankings}
      status={payload.rankings.status}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Tracked keywords"
          value={String(payload.rankings.trackedKeywords ?? "—")}
        />
        <MetricCard
          label="Improved"
          value={String(payload.rankings.improved ?? "—")}
        />
        <MetricCard
          label="Declined"
          value={String(payload.rankings.declined ?? "—")}
        />
        <MetricCard
          label="Top 10"
          value={String(payload.rankings.top10 ?? "—")}
        />
      </div>
      {payload.rankings.lastCheckedAt ? (
        <p className="mt-2 text-sm text-base-content/60">
          Last checked {formatDateTime(payload.rankings.lastCheckedAt)}
        </p>
      ) : null}
    </SectionShell>
  );
}

function TechnicalSection({ payload }: { payload: ReportPayload }) {
  const topIssues = payload.technical.topIssues ?? [];
  return (
    <SectionShell
      title={SECTION_TITLES.technical}
      status={payload.technical.status}
    >
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="Audit status"
          value={payload.technical.auditStatus ?? "—"}
        />
        <MetricCard
          label="Pages crawled"
          value={String(payload.technical.pagesCrawled ?? "—")}
        />
      </div>
      {topIssues.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {topIssues.map((issue) => (
            <li key={issue.issueType}>
              {issue.issueType} — {issue.count} pages ({issue.severity})
            </li>
          ))}
        </ul>
      ) : null}
    </SectionShell>
  );
}

function BacklinksSection({ payload }: { payload: ReportPayload }) {
  return (
    <SectionShell
      title={SECTION_TITLES.backlinks}
      status={payload.backlinks.status}
    >
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="Referring domains"
          value={String(payload.backlinks.referringDomains ?? "—")}
        />
        <MetricCard
          label="Captured"
          value={formatDateTime(payload.backlinks.capturedAt)}
        />
      </div>
    </SectionShell>
  );
}

function OpportunitiesSection({ payload }: { payload: ReportPayload }) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <h2 className="font-semibold">{SECTION_TITLES.opportunities}</h2>
      {payload.opportunities.length === 0 ? (
        <p className="mt-2 text-sm text-base-content/60">
          No opportunities in this snapshot.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {payload.opportunities.map((opportunity) => (
            <li
              key={opportunity.id}
              className="rounded-lg border border-base-300 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={priorityBadgeClass(opportunity.priority)}>
                  {priorityLabel(opportunity.priority)}
                </span>
                <span className={statusBadgeClass(opportunity.status)}>
                  {statusLabel(opportunity.status)}
                </span>
              </div>
              <p className="mt-1 font-medium">{opportunity.title}</p>
              <p className="text-sm text-base-content/70">
                {opportunity.explanationFact}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InsightsSection({ payload }: { payload: ReportPayload }) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <h2 className="font-semibold">{SECTION_TITLES.insights}</h2>
      {payload.insights.length === 0 ? (
        <p className="mt-2 text-sm text-base-content/60">
          No insights in this snapshot.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {payload.insights.map((insight) => (
            <li
              key={insight.insightKey}
              className="rounded-lg border border-base-300 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={severityBadgeClass(insight.severity)}>
                  {insight.severity}
                </span>
                <span className="badge badge-outline badge-sm">
                  {insight.type}
                </span>
              </div>
              <p className="mt-1 font-medium">{insight.title}</p>
              <p className="text-sm text-base-content/70">
                {insight.explanationFact}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReportBody({ payload }: { payload: ReportPayload }) {
  const show = (key: (typeof payload.sections)[number]) =>
    payload.sections.includes(key);
  return (
    <div className="space-y-4">
      {show("search_visibility") ? (
        <SearchVisibilitySection payload={payload} />
      ) : null}
      {show("traffic") ? <TrafficSection payload={payload} /> : null}
      {show("conversions") ? <ConversionsSection payload={payload} /> : null}
      {show("rankings") ? <RankingsSection payload={payload} /> : null}
      {show("technical") ? <TechnicalSection payload={payload} /> : null}
      {show("backlinks") ? <BacklinksSection payload={payload} /> : null}
      {show("opportunities") ? (
        <OpportunitiesSection payload={payload} />
      ) : null}
      {show("insights") ? <InsightsSection payload={payload} /> : null}
    </div>
  );
}
