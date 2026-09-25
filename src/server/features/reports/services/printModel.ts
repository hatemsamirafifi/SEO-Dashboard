import {
  consistencyBanner,
  REPORT_SECTION_TITLES,
  REPORT_TYPE_LABELS,
  unavailableSectionNote,
  type BrandingSnapshot,
  type ReportPayload,
  type ReportSectionKey,
} from "@/shared/reports";

// Shared print model (final-plan §12): one ordered block structure built
// from the frozen payload, consumed by the PDF emitter and the print-CSS
// HTML emitter. Renderers add layout only — never data.

export type PrintMetricRow = { label: string; value: string };
export type PrintListItem = { lead: string; title: string; body: string };

export type PrintSection = {
  key: ReportSectionKey;
  title: string;
  metricRows: PrintMetricRow[];
  items: PrintListItem[];
  emptyNote: string | null;
  unavailableNote: string | null;
};

export type PrintModel = {
  title: string;
  subtitle: string;
  footer: string | null;
  banner: string;
  provenanceLines: string[];
  sections: PrintSection[];
};

function formatCount(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatPercent(ratio: number | null): string {
  return ratio === null ? "—" : `${(ratio * 100).toFixed(1)}%`;
}

function formatPosition(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function metricSection(
  key: ReportSectionKey,
  status: { available: boolean; reason: string | null },
  rows: PrintMetricRow[],
): PrintSection {
  return {
    key,
    title: REPORT_SECTION_TITLES[key],
    metricRows: status.available ? rows : [],
    items: [],
    emptyNote: null,
    unavailableNote: status.available
      ? null
      : (unavailableSectionNote(status.reason) ?? "Unavailable."),
  };
}

function listSection(
  key: ReportSectionKey,
  items: PrintListItem[],
  emptyNote: string,
): PrintSection {
  return {
    key,
    title: REPORT_SECTION_TITLES[key],
    metricRows: [],
    items,
    emptyNote: items.length === 0 ? emptyNote : null,
    unavailableNote: null,
  };
}

export function buildPrintModel(
  payload: ReportPayload,
  branding: BrandingSnapshot | null,
): PrintModel {
  const agencyName = branding?.agency?.name ?? "OpenSEO";
  const clientName = branding?.client?.name ?? null;
  const title =
    branding?.client?.titleOverride ??
    `${REPORT_TYPE_LABELS[payload.reportType]} report`;
  const provenanceLines = [
    `Generated ${payload.generatedAt}`,
    payload.provenance.hasSuccessfulScan
      ? `Intelligence from scan ${payload.provenance.intelligenceRunId?.slice(0, 8) ?? "unknown"}${payload.provenance.intelligenceStale ? " (stale)" : ""}${payload.provenance.intelligenceCompletedAt ? `, completed ${payload.provenance.intelligenceCompletedAt}` : ""}`
      : "No successful intelligence scan at generation time.",
  ];
  const sections: PrintSection[] = [];
  for (const key of payload.sections) {
    switch (key) {
      case "search_visibility": {
        const totals = payload.searchVisibility.totals;
        sections.push(
          metricSection(key, payload.searchVisibility.status, [
            { label: "Clicks", value: formatCount(totals?.clicks ?? null) },
            {
              label: "Impressions",
              value: formatCount(totals?.impressions ?? null),
            },
            { label: "CTR", value: formatPercent(totals?.ctr ?? null) },
            {
              label: "Avg. position",
              value: formatPosition(totals?.position ?? null),
            },
          ]),
        );
        break;
      }
      case "traffic": {
        const totals = payload.traffic.totals;
        sections.push(
          metricSection(key, payload.traffic.status, [
            { label: "Sessions", value: formatCount(totals?.sessions ?? null) },
            {
              label: "Engaged sessions",
              value: formatCount(totals?.engagedSessions ?? null),
            },
            {
              label: "Page views",
              value: formatCount(totals?.screenPageViews ?? null),
            },
            {
              label: "New users",
              value: formatCount(totals?.newUsers ?? null),
            },
          ]),
        );
        break;
      }
      case "conversions":
        sections.push(
          metricSection(key, payload.conversions.status, [
            {
              label: "Key events",
              value: formatCount(payload.conversions.keyEvents),
            },
            {
              label: "Transactions",
              value: formatCount(payload.conversions.transactions),
            },
          ]),
        );
        break;
      case "rankings":
        sections.push(
          metricSection(key, payload.rankings.status, [
            {
              label: "Tracked keywords",
              value: formatCount(payload.rankings.trackedKeywords),
            },
            { label: "Improved", value: formatCount(payload.rankings.improved) },
            { label: "Declined", value: formatCount(payload.rankings.declined) },
            { label: "Top 10", value: formatCount(payload.rankings.top10) },
            {
              label: "Last checked",
              value: payload.rankings.lastCheckedAt ?? "—",
            },
          ]),
        );
        break;
      case "technical": {
        const topIssues = payload.technical.topIssues ?? [];
        sections.push({
          key,
          title: REPORT_SECTION_TITLES[key],
          metricRows: payload.technical.status.available
            ? [
                {
                  label: "Audit status",
                  value: payload.technical.auditStatus ?? "—",
                },
                {
                  label: "Pages crawled",
                  value: formatCount(payload.technical.pagesCrawled),
                },
              ]
            : [],
          items: topIssues.map((issue) => ({
            lead: issue.severity,
            title: issue.issueType,
            body: `${issue.count} pages`,
          })),
          emptyNote:
            payload.technical.status.available && topIssues.length === 0
              ? "No issues recorded."
              : null,
          unavailableNote: payload.technical.status.available
            ? null
            : (unavailableSectionNote(payload.technical.status.reason) ??
              "Unavailable."),
        });
        break;
      }
      case "backlinks":
        sections.push(
          metricSection(key, payload.backlinks.status, [
            {
              label: "Referring domains",
              value: formatCount(payload.backlinks.referringDomains),
            },
            {
              label: "Captured",
              value: payload.backlinks.capturedAt ?? "—",
            },
          ]),
        );
        break;
      case "opportunities":
        sections.push(
          listSection(
            key,
            payload.opportunities.map((opportunity) => ({
              lead: `${opportunity.priority} / ${opportunity.status}`,
              title: opportunity.title,
              body: opportunity.explanationFact,
            })),
            "No opportunities in this snapshot.",
          ),
        );
        break;
      case "insights":
        sections.push(
          listSection(
            key,
            payload.insights.map((insight) => ({
              lead: `${insight.severity} / ${insight.type}`,
              title: insight.title,
              body: insight.explanationFact,
            })),
            "No insights in this snapshot.",
          ),
        );
        break;
    }
  }
  return {
    title,
    subtitle: `${agencyName}${clientName ? ` for ${clientName}` : ""} · ${payload.period.from} → ${payload.period.to}`,
    footer: branding?.agency?.footerText ?? null,
    banner: consistencyBanner(payload.provenance),
    provenanceLines,
    sections,
  };
}
