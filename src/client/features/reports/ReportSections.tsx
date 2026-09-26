import {
  consistencyBanner,
  type BrandingSnapshot,
  type ReportPayload,
} from "@/shared/reports";
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-base-300 p-3">
      <div className="text-xs text-base-content/60">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
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

function BrandLogo({ r2Key, name }: { r2Key: string; name: string }) {
  return (
    <img
      src={`/api/brand-logo?key=${encodeURIComponent(r2Key)}`}
      alt={`${name} logo`}
      className="h-10 max-w-40 object-contain"
    />
  );
}

/**
 * Frozen agency+client header (the branding preview). Null snapshots render
 * the default OpenSEO header — branding is never invented.
 */
export function BrandedReportHeader({
  branding,
  defaultTitle,
  periodLabel,
}: {
  branding: BrandingSnapshot | null;
  defaultTitle: string;
  periodLabel: string;
}) {
  const agency = branding?.agency;
  const client = branding?.client;
  return (
    <header
      className="rounded-xl border border-base-300 bg-base-100 p-4"
      style={
        agency?.accentColor
          ? { borderTop: `4px solid ${agency.accentColor}` }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        {agency?.logoR2Key ? (
          <BrandLogo r2Key={agency.logoR2Key} name={agency.name} />
        ) : null}
        <div>
          <p className="text-sm text-base-content/60">
            {agency ? agency.name : "OpenSEO"}
            {client ? ` for ${client.name}` : ""}
          </p>
          <h1 className="text-xl font-semibold">
            {client?.titleOverride ?? defaultTitle}
          </h1>
          <p className="text-sm text-base-content/60">{periodLabel}</p>
        </div>
        {client?.logoR2Key ? (
          <div className="ml-auto">
            <BrandLogo r2Key={client.logoR2Key} name={client.name} />
          </div>
        ) : null}
      </div>
      {agency?.footerText ? (
        <p className="mt-3 text-sm text-base-content/60">{agency.footerText}</p>
      ) : null}
    </header>
  );
}

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

export function ReportBody({ payload }: { payload: ReportPayload }) {
  const sections = payload.sections;
  const show = (key: (typeof sections)[number]): boolean =>
    sections.includes(key);
  return (
    <div className="space-y-4">
      {show("search_visibility") ? (
        <SectionShell
          title={SECTION_TITLES.search_visibility}
          status={payload.searchVisibility.status}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard
              label="Clicks"
              value={String(payload.searchVisibility.totals?.clicks ?? "—")}
            />
            <MetricCard
              label="Impressions"
              value={String(
                payload.searchVisibility.totals?.impressions ?? "—",
              )}
            />
            <MetricCard
              label="CTR"
              value={
                payload.searchVisibility.totals
                  ? formatPercent(payload.searchVisibility.totals.ctr)
                  : "—"
              }
            />
            <MetricCard
              label="Avg. position"
              value={
                payload.searchVisibility.totals
                  ? payload.searchVisibility.totals.position.toFixed(1)
                  : "—"
              }
            />
          </div>
        </SectionShell>
      ) : null}

      {show("traffic") ? (
        <SectionShell
          title={SECTION_TITLES.traffic}
          status={payload.traffic.status}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard
              label="Sessions"
              value={String(payload.traffic.totals?.sessions ?? "—")}
            />
            <MetricCard
              label="Engaged sessions"
              value={String(payload.traffic.totals?.engagedSessions ?? "—")}
            />
            <MetricCard
              label="Page views"
              value={String(payload.traffic.totals?.screenPageViews ?? "—")}
            />
            <MetricCard
              label="New users"
              value={String(payload.traffic.totals?.newUsers ?? "—")}
            />
          </div>
        </SectionShell>
      ) : null}

      {show("conversions") ? (
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
      ) : null}

      {show("rankings") ? (
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
      ) : null}

      {show("technical") ? (
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
          {payload.technical.topIssues &&
          payload.technical.topIssues.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {payload.technical.topIssues.map((issue) => (
                <li key={issue.issueType}>
                  {issue.issueType} — {issue.count} pages ({issue.severity})
                </li>
              ))}
            </ul>
          ) : null}
        </SectionShell>
      ) : null}

      {show("backlinks") ? (
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
      ) : null}

      {show("opportunities") ? (
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
      ) : null}

      {show("insights") ? (
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
      ) : null}
    </div>
  );
}
