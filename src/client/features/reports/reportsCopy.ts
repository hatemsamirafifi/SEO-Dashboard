import {
  REPORT_TYPES,
  type ReportSectionKey,
  type ReportType,
} from "@/shared/reports";

// Presentation copy for the reports UI. No detector, threshold, or scoring
// logic lives here — labels and formatting only.

export const REPORT_TYPE_OPTIONS: Array<{
  value: ReportType;
  label: string;
  description: string;
}> = [
  {
    value: "overview",
    label: "Overview",
    description:
      "Every section: traffic, visibility, rankings, technical, and more.",
  },
  {
    value: "search_performance",
    label: "Search performance",
    description: "Search visibility with related insights and opportunities.",
  },
  {
    value: "rank_tracking",
    label: "Rank tracking",
    description: "Ranking movement with related insights and opportunities.",
  },
  {
    value: "technical",
    label: "Technical",
    description: "Audit health with related insights and opportunities.",
  },
  {
    value: "executive",
    label: "Executive",
    description: "Visibility and traffic summary with top opportunities.",
  },
];

export function reportTypeLabel(type: string): string {
  return (
    REPORT_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type
  );
}

export function assertReportType(value: string): asserts value is ReportType {
  if (!(REPORT_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unknown report type: ${value}`);
  }
}

export const SECTION_TITLES: Record<ReportSectionKey, string> = {
  search_visibility: "Search visibility",
  traffic: "Traffic",
  conversions: "Conversions",
  rankings: "Rankings",
  technical: "Technical health",
  backlinks: "Backlinks",
  opportunities: "Opportunities",
  insights: "Insights",
};

export function consistencyLabel(status: string): string {
  return status === "concurrent_mutation"
    ? "Data changed during collection"
    : "Stable data";
}

export function consistencyBadgeClass(status: string): string {
  return status === "concurrent_mutation"
    ? "badge badge-warning badge-sm"
    : "badge badge-success badge-sm";
}

export function availabilityNote(reason: string | null): string | null {
  switch (reason) {
    case "not_connected":
      return "Not connected — connect this source to include its data.";
    case "no_coverage":
      return "No coverage for this period.";
    case "provider_failed":
      return "Collection failed — this section is unavailable.";
    case "no_data":
      return "No data yet.";
    default:
      return null;
  }
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function formatPeriod(period: { from: string; to: string }): string {
  return `${period.from} → ${period.to}`;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Default report window: the last 28 days ending today. */
export function defaultPeriod(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 27 * 86_400_000);
  return { from: toIsoDate(from), to: toIsoDate(to) };
}
