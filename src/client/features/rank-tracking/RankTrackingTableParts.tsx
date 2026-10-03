import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  SERP_FAMILY_LABELS,
  type SerpFamilyKey,
} from "@/server/features/serp/featurePresentation";
import { buildCsv, downloadCsv } from "@/client/lib/csv";
import { exportTableToSheets } from "@/client/lib/exportToSheets";
import { captureClientEvent } from "@/client/lib/posthog";
import { formatLocationLabel } from "@/shared/keyword-locations";
import { getErrorMessage } from "@/client/lib/error-messages";
import type {
  RankTrackingDeviceResult,
  RankTrackingRow,
} from "@/types/schemas/rank-tracking";

/* Legacy rank-result feature keys → frozen spec-003 families (spec 011,
 *  S4 vocabulary consolidation). Stored `serpFeatures` string lists predate
 *  the frozen contract and use provider-style names; this adapter is the
 *  ONLY place that vocabulary lives. `ai_overview` is not one of the frozen
 *  ten families and is dropped (AI-overview work belongs to a future spec
 *  that extends the 003 contract properly). */
export function normalizeLegacyFeatureKey(key: string): SerpFamilyKey | null {
  switch (key) {
    case "featured_snippet":
    case "featured_result":
      return "featuredResult";
    case "people_also_ask":
      return "peopleAlsoAsk";
    case "related_searches":
      return "relatedSearches";
    case "local_pack":
      return "localPack";
    case "images":
      return "images";
    case "video":
    case "videos":
      return "videos";
    case "shopping":
      return "shopping";
    case "top_stories":
    case "news":
      return "news";
    case "knowledge_panel":
    case "knowledge_graph":
      return "knowledgeGraph";
    case "sitelinks":
      return "sitelinks";
    default:
      return null;
  }
}

export function SerpFeatureTags({ features }: { features: string[] }) {
  const families = [
    ...new Set(
      features.flatMap((f) => {
        const family = normalizeLegacyFeatureKey(f);
        return family === null ? [] : [family];
      }),
    ),
  ];
  if (families.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {families.map((family) => (
        <span
          key={family}
          className="badge badge-xs gap-0.5 cursor-help bg-base-300 border-0 text-base-content/70"
          title={`${SERP_FAMILY_LABELS[family]} — SERP feature observed for this keyword`}
        >
          {SERP_FAMILY_LABELS[family]}
        </span>
      ))}
    </div>
  );
}

export function DeviceRankCell({
  result,
  isChecking = false,
  serpDepth,
}: {
  result: RankTrackingDeviceResult;
  isChecking?: boolean;
  serpDepth?: number;
}) {
  const { position, previousPosition, checkedAt, status } = result;
  const depthLabel = serpDepth ? `top ${serpDepth}` : "tracked search depth";

  if (isChecking || status === "checking") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-primary font-medium">
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </span>
    );
  }

  if (status === "failed" || result.rankingStatus === "CHECK_FAILED") {
    const errorMsg =
      (result.errorCode ? getErrorMessage(result.errorCode) : null) ||
      result.errorMessage ||
      result.providerStatus ||
      "Ranking unavailable";
    const errorTooltip = result.latestValidPosition
      ? `${errorMsg} (Last valid: #${result.latestValidPosition})`
      : errorMsg;
    return (
      <span
        className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold bg-error/20 text-error"
        title={errorTooltip}
      >
        Ranking unavailable
      </span>
    );
  }

  // Nothing at all
  if (position === null && previousPosition === null) {
    if (status === "not_ranking" || checkedAt) {
      return (
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-base-200 text-base-content/70"
          title={`Checked: Domain is not ranking in ${depthLabel} Google organic results`}
        >
          No ranking found
        </span>
      );
    }
    return (
      <span
        className="text-xs text-base-content/40 italic"
        title="This keyword has not been checked yet"
      >
        Not checked
      </span>
    );
  }

  // Was ranking, now lost
  if (position === null && previousPosition !== null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-xs text-base-content/40 w-6 text-right">
          #{previousPosition}
        </span>
        <span className="text-base-content/30">→</span>
        <span
          className="font-mono rounded px-1.5 py-0.5 text-xs font-semibold bg-error/20 text-error"
          title={`Dropped out of ${depthLabel}`}
        >
          lost
        </span>
      </span>
    );
  }

  // First check — no previous data
  if (previousPosition === null) {
    return <span className="font-mono font-semibold">#{position}</span>;
  }

  // Both exist — show old → new with colored badge
  const change = previousPosition - position!;
  let badgeClass = "bg-base-200 text-base-content";
  if (change > 0) badgeClass = "bg-success/20 text-success";
  if (change < 0) badgeClass = "bg-warning/20 text-warning";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-base-content/40 w-6 text-right">
        #{previousPosition}
      </span>
      <span className="text-base-content/30">→</span>
      <span
        className={`font-mono rounded px-1.5 py-0.5 text-xs font-semibold ${badgeClass}`}
      >
        #{position}
      </span>
    </span>
  );
}

export function DeviceUrlCell({
  result,
  domain,
  serpDepth,
}: {
  result: RankTrackingDeviceResult;
  domain: string;
  serpDepth?: number;
}) {
  const depthLabel = serpDepth ? `top ${serpDepth}` : "tracked search depth";
  if (result.status === "failed" || result.rankingStatus === "CHECK_FAILED") {
    return (
      <span
        className="text-xs text-base-content/40 italic"
        title="URL unavailable because rank check failed"
      >
        —
      </span>
    );
  }

  if (!result.rankingUrl) {
    if (result.status === "not_ranking" || result.checkedAt) {
      return (
        <span
          className="text-xs text-base-content/40 italic"
          title={`No ranking URL in ${depthLabel}`}
        >
          No ranking URL
        </span>
      );
    }
    return <span className="text-base-content/40 text-xs">-</span>;
  }
  return (
    <a
      href={toFullUrl(result.rankingUrl, domain)}
      target="_blank"
      rel="noopener noreferrer"
      className="link link-hover block w-full max-w-full break-words [overflow-wrap:anywhere] line-clamp-3 text-xs leading-relaxed"
      title={safeDecode(result.rankingUrl)}
    >
      {toPath(result.rankingUrl)}
    </a>
  );
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function VolumeCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-base-content/40">-</span>;
  return (
    <span className="font-mono text-sm">{compactFormatter.format(value)}</span>
  );
}

export function DifficultyCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-base-content/40">-</span>;
  let badgeClass = "bg-success/20 text-success";
  if (value > 60) badgeClass = "bg-error/20 text-error";
  else if (value > 30) badgeClass = "bg-warning/20 text-warning";
  return (
    <span
      className={`font-mono rounded px-1.5 py-0.5 text-xs font-semibold ${badgeClass}`}
    >
      {value}
    </span>
  );
}

export function CpcCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-base-content/40">-</span>;
  return <span className="font-mono text-sm">${value.toFixed(2)}</span>;
}

/** Numeric change for CSV export — numbers bypass the CSV formula-injection sanitizer */
export function csvChange(
  current: number | null,
  previous: number | null,
): number | string {
  if (previous === null) return current !== null ? "new" : "";
  if (current === null) return "lost";
  return previous - current;
}

export function buildRankTrackingExport(
  sorted: RankTrackingRow[],
  showDesktop: boolean,
  showMobile: boolean,
  locationName?: string | null,
): { headers: string[]; rows: (string | number)[][] } {
  const headers = [
    "Keyword",
    // Exports lack the table's tooltip, so name the city inline.
    locationName
      ? `Local volume (${formatLocationLabel(locationName, 2)})`
      : "Volume",
    "KD",
    "CPC",
    ...(showDesktop
      ? [
          "Desktop Position",
          "Desktop Change",
          "Desktop URL",
          "Desktop SERP Features",
        ]
      : []),
    ...(showMobile
      ? [
          "Mobile Position",
          "Mobile Change",
          "Mobile URL",
          "Mobile SERP Features",
        ]
      : []),
  ];
  // Emit empty cells (not "Not ranking" strings) so Sheets infers a numeric
  // column type and the user can sort by position.
  const rows = sorted.map((row) => [
    row.keyword,
    row.searchVolume ?? "",
    row.keywordDifficulty ?? "",
    row.cpc ?? "",
    ...(showDesktop
      ? [
          row.desktop.position ?? "",
          csvChange(row.desktop.position, row.desktop.previousPosition),
          row.desktop.rankingUrl ?? "",
          row.desktop.serpFeatures.join(", "),
        ]
      : []),
    ...(showMobile
      ? [
          row.mobile.position ?? "",
          csvChange(row.mobile.position, row.mobile.previousPosition),
          row.mobile.rankingUrl ?? "",
          row.mobile.serpFeatures.join(", "),
        ]
      : []),
  ]);
  return { headers, rows };
}

export function exportRankTrackingToSheets(
  sorted: RankTrackingRow[],
  showDesktop: boolean,
  showMobile: boolean,
  locationName?: string | null,
) {
  const { headers, rows } = buildRankTrackingExport(
    sorted,
    showDesktop,
    showMobile,
    locationName,
  );
  void exportTableToSheets({ headers, rows, feature: "rank_tracking" });
}

export function exportRankTrackingCsv(
  sorted: RankTrackingRow[],
  showDesktop: boolean,
  showMobile: boolean,
  domain: string,
  locationName?: string | null,
) {
  if (sorted.length === 0) {
    toast.error("No data to export");
    return;
  }
  const { headers, rows } = buildRankTrackingExport(
    sorted,
    showDesktop,
    showMobile,
    locationName,
  );
  // CSV file download keeps cents-formatted CPC for human readability;
  // clipboard/Sheets export uses raw numbers (see buildRankTrackingExport).
  const csvRows = rows.map((row) =>
    row.map((cell, idx) =>
      idx === 3 && typeof cell === "number" ? cell.toFixed(2) : cell,
    ),
  );
  downloadCsv(`rank-tracking-${domain}.csv`, buildCsv(headers, csvRows));
  captureClientEvent("rank_tracking:export_csv");
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function toPath(url: string): string {
  try {
    const path = new URL(url).pathname;
    return safeDecode(path);
  } catch {
    return safeDecode(url);
  }
}

function toFullUrl(url: string, domain: string): string {
  if (url.startsWith("http")) return url;
  return `https://${domain}${url}`;
}
