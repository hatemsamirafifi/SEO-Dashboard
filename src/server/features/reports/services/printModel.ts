import {
  consistencyBanner,
  containsArabicText,
  PAID_SEARCH_SECTION_TITLE,
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

export const PAID_SEARCH_SECTION_KEY = "paid_search";

export type PrintMetricRow = { label: string; value: string };
export type PrintListItem = { lead: string; title: string; body: string };

type PaidListTotals = NonNullable<
  NonNullable<ReportPayload["paidSearch"]>["campaigns"][number]["totals"]
>;

export type PrintSection = {
  key: ReportSectionKey | typeof PAID_SEARCH_SECTION_KEY;
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

function formatPrintPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatPrintMultiple(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}x`;
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

function formatNumber(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(value: number | null, code: string | null): string {
  if (value === null) return "—";
  return `${value.toFixed(2)}${code ? ` ${code}` : ""}`;
}

function buildPaidSearchSection(payload: ReportPayload): PrintSection[] {
  const paid = payload.paidSearch;
  if (!paid) return [];
  const currency = paid.currencyCode;
  const prev = paid.previousTotals;
  const totals = paid.totals;
  const money = (value: number | null) => formatMoney(value, currency);
  // (prev: …) suffixes mirror the other sections: only when the equal-length
  // preceding window was actually compared (previousTotals non-null).
  const withPrev = (current: string, previous: string | null) =>
    prev && previous !== null ? `${current} (prev: ${previous})` : current;
  const metricRows: PrintMetricRow[] = totals
    ? [
        {
          label: "Impressions",
          value: withPrev(
            formatNumber(totals.impressions),
            formatNumber(prev?.impressions ?? null),
          ),
        },
        {
          label: "Clicks",
          value: withPrev(
            formatNumber(totals.clicks),
            formatNumber(prev?.clicks ?? null),
          ),
        },
        {
          label: "Cost",
          value: withPrev(money(totals.cost), money(prev?.cost ?? null)),
        },
        {
          label: "Conversions",
          value: withPrev(
            formatNumber(totals.conversions),
            formatNumber(prev?.conversions ?? null),
          ),
        },
        {
          label: "Conversions value",
          value: withPrev(
            money(totals.conversionsValue),
            money(prev?.conversionsValue ?? null),
          ),
        },
        {
          label: "CTR",
          value: withPrev(
            formatPrintPercent(totals.ctr),
            formatPrintPercent(prev?.ctr ?? null),
          ),
        },
        {
          label: "CPC",
          value: money(totals.cpc),
        },
        {
          label: "CPA",
          value: money(totals.cpa),
        },
        {
          label: "ROAS",
          value: formatPrintMultiple(totals.roas),
        },
        ...(paid.metricDateBasis
          ? [{ label: "Metric date basis", value: paid.metricDateBasis }]
          : []),
      ]
    : [];
  const items: PrintListItem[] = [
    ...paid.campaigns.map((campaign) => ({
      lead: campaign.status ?? "campaign",
      title: campaign.name ?? campaign.campaignResourceId,
      body: paidRowBody(campaign.totals, currency),
    })),
    ...paid.searchTerms.map((term) => ({
      lead: "Search term",
      title: term.searchText,
      body: paidRowBody(term.totals, currency),
    })),
  ];
  return [
    {
      key: PAID_SEARCH_SECTION_KEY,
      title: PAID_SEARCH_SECTION_TITLE,
      metricRows: paid.status.available ? metricRows : [],
      items,
      emptyNote: paid.status.available
        ? totals === null
          ? "No paid search data in this period."
          : items.length === 0
            ? "No campaign or search-term data in this period."
            : null
        : null,
      unavailableNote: paid.status.available
        ? null
        : (unavailableSectionNote(paid.status.reason) ?? "Unavailable."),
    },
  ];
}

function paidRowBody(totals: PaidListTotals, currency: string | null): string {
  return `impressions ${formatNumber(totals.impressions)} · clicks ${formatNumber(totals.clicks)} · cost ${formatMoney(totals.cost, currency)}`;
}

function buildVisibilitySection(payload: ReportPayload): PrintSection {
  const totals = payload.searchVisibility.totals;
  const prev = payload.searchVisibility.previousTotals;
  return metricSection("search_visibility", payload.searchVisibility.status, [
    {
      label: "Clicks",
      value: prev
        ? `${formatCount(totals?.clicks ?? null)} (prev: ${formatCount(prev.clicks)})`
        : formatCount(totals?.clicks ?? null),
    },
    {
      label: "Impressions",
      value: prev
        ? `${formatCount(totals?.impressions ?? null)} (prev: ${formatCount(prev.impressions)})`
        : formatCount(totals?.impressions ?? null),
    },
    {
      label: "CTR",
      value: prev
        ? `${formatPrintPercent(totals?.ctr ?? null)} (prev: ${formatPrintPercent(prev.ctr)})`
        : formatPrintPercent(totals?.ctr ?? null),
    },
    {
      label: "Avg. position",
      value: prev
        ? `${formatPosition(totals?.position ?? null)} (prev: ${formatPosition(prev.position)})`
        : formatPosition(totals?.position ?? null),
    },
  ]);
}

function buildTrafficSection(payload: ReportPayload): PrintSection {
  const totals = payload.traffic.totals;
  const prev = payload.traffic.previousTotals;
  return metricSection("traffic", payload.traffic.status, [
    {
      label: "Sessions",
      value: prev
        ? `${formatCount(totals?.sessions ?? null)} (prev: ${formatCount(prev.sessions)})`
        : formatCount(totals?.sessions ?? null),
    },
    {
      label: "Engaged sessions",
      value: prev
        ? `${formatCount(totals?.engagedSessions ?? null)} (prev: ${formatCount(prev.engagedSessions)})`
        : formatCount(totals?.engagedSessions ?? null),
    },
    {
      label: "Page views",
      value: prev
        ? `${formatCount(totals?.screenPageViews ?? null)} (prev: ${formatCount(prev.screenPageViews)})`
        : formatCount(totals?.screenPageViews ?? null),
    },
    {
      label: "New users",
      value: prev
        ? `${formatCount(totals?.newUsers ?? null)} (prev: ${formatCount(prev.newUsers)})`
        : formatCount(totals?.newUsers ?? null),
    },
  ]);
}

function buildTechnicalSection(payload: ReportPayload): PrintSection {
  const tech = payload.technical;
  const topIssues = tech.topIssues ?? [];
  return {
    key: "technical",
    title: REPORT_SECTION_TITLES.technical,
    metricRows: tech.status.available
      ? [
          { label: "Audit status", value: tech.auditStatus ?? "—" },
          { label: "Pages crawled", value: formatCount(tech.pagesCrawled) },
        ]
      : [],
    items: topIssues.map((issue) => ({
      lead: issue.severity,
      title: issue.issueType,
      body: `${issue.count} pages`,
    })),
    emptyNote:
      tech.status.available && topIssues.length === 0
        ? "No issues recorded."
        : null,
    unavailableNote: tech.status.available
      ? null
      : (unavailableSectionNote(tech.status.reason) ?? "Unavailable."),
  };
}

function buildSectionByKey(
  key: ReportSectionKey,
  payload: ReportPayload,
): PrintSection {
  switch (key) {
    case "search_visibility":
      return buildVisibilitySection(payload);
    case "traffic":
      return buildTrafficSection(payload);
    case "conversions": {
      const conversions = payload.conversions;
      return metricSection(key, conversions.status, [
        { label: "Key events", value: formatCount(conversions.keyEvents) },
        {
          label: "Transactions",
          value: formatCount(conversions.transactions),
        },
      ]);
    }
    case "rankings": {
      const rank = payload.rankings;
      return metricSection(key, rank.status, [
        {
          label: "Tracked keywords",
          value: formatCount(rank.trackedKeywords),
        },
        { label: "Improved", value: formatCount(rank.improved) },
        { label: "Declined", value: formatCount(rank.declined) },
        { label: "Top 10", value: formatCount(rank.top10) },
        { label: "Last checked", value: rank.lastCheckedAt ?? "—" },
      ]);
    }
    case "technical":
      return buildTechnicalSection(payload);
    case "backlinks": {
      const backlinks = payload.backlinks;
      return metricSection(key, backlinks.status, [
        {
          label: "Referring domains",
          value: formatCount(backlinks.referringDomains),
        },
        { label: "Captured", value: backlinks.capturedAt ?? "—" },
      ]);
    }
    case "opportunities":
      return listSection(
        key,
        payload.opportunities.map((opportunity) => ({
          lead: `${opportunity.priority} / ${opportunity.status}`,
          title: opportunity.title,
          body: opportunity.explanationFact,
        })),
        "No opportunities in this snapshot.",
      );
    case "insights":
      return listSection(
        key,
        payload.insights.map((insight) => ({
          lead: `${insight.severity} / ${insight.type}`,
          title: insight.title,
          body: insight.explanationFact,
        })),
        "No insights in this snapshot.",
      );
  }
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

  const sections = [
    ...payload.sections.map((key) => buildSectionByKey(key, payload)),
    ...buildPaidSearchSection(payload),
  ];
  return {
    title,
    subtitle: `${agencyName}${clientName ? ` for ${clientName}` : ""} · ${payload.period.from} → ${payload.period.to}`,
    footer: branding?.agency?.footerText ?? null,
    banner: consistencyBanner(payload.provenance),
    provenanceLines,
    sections,
  };
}

export function hasUnsupportedArabicText(model: PrintModel): boolean {
  if (containsArabicText(model.title) || containsArabicText(model.subtitle)) {
    return true;
  }
  if (containsArabicText(model.footer)) return true;
  if (containsArabicText(model.banner)) return true;
  for (const line of model.provenanceLines) {
    if (containsArabicText(line)) return true;
  }
  for (const section of model.sections) {
    if (
      [section.title, section.emptyNote, section.unavailableNote].some(
        containsArabicText,
      )
    ) {
      return true;
    }
    for (const row of section.metricRows) {
      if ([row.label, row.value].some(containsArabicText)) return true;
    }
    for (const item of section.items) {
      if ([item.lead, item.title, item.body].some(containsArabicText)) {
        return true;
      }
    }
  }
  return false;
}
