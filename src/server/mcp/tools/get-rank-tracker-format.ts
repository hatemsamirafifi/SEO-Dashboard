import type { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import type { McpTableColumn } from "@/server/mcp/table";
import type {
  RankTrackingDeviceResult,
  RankTrackingRow,
} from "@/types/schemas/rank-tracking";

export type TargetRow = Awaited<
  ReturnType<typeof RankTrackingTargetRepository.getTargetsForProject>
>[number];

export interface FlattenedRankObservationRow {
  keyword: string;
  target: string;
  device: "desktop" | "mobile";
  position: number | null;
  obsDate: string | null;
  prevComparable: number | null;
  prevDate: string | null;
  movement: number | null;
  providerDelta: number | null;
  provider: string | null;
  provenance: string | null;
  comparisonMethod: string;
  url: string | null;
  status: string;
}

function formatSignedChange(val: number | null | undefined): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "—";
  if (val > 0) return `+${val}`;
  return String(val);
}

export function formatTargetLabel(
  target: Pick<
    TargetRow,
    "countryCode" | "cityName" | "languageCode" | "device"
  >,
): string {
  return `${target.countryCode.toUpperCase()}${target.cityName ? `/${target.cityName}` : ""} (${target.languageCode}) ${target.device}`;
}

function resolveProvenance(result: RankTrackingDeviceResult): string | null {
  const parts: string[] = [];
  if (result.observationSource) parts.push(result.observationSource);
  if (result.completionConfidence) parts.push(result.completionConfidence);
  return parts.length > 0 ? parts.join(" / ") : null;
}

function resolveObsDate(result: RankTrackingDeviceResult): string | null {
  if (result.checkedDate) return result.checkedDate;
  if (result.checkedAt) return result.checkedAt.slice(0, 10);
  return null;
}

function enrichDeviceResult(
  result: RankTrackingDeviceResult,
  device: "desktop" | "mobile",
  targetById: Map<string, TargetRow>,
  singleTargetByDevice: Partial<Record<"desktop" | "mobile", TargetRow>>,
): RankTrackingDeviceResult {
  const matchedTarget =
    (result.trackingTargetId
      ? targetById.get(result.trackingTargetId)
      : undefined) ?? singleTargetByDevice[device];

  const prevComparable =
    result.previousComparablePosition !== undefined
      ? result.previousComparablePosition
      : result.previousPosition;
  const positionChange =
    result.positionChange !== undefined
      ? result.positionChange
      : typeof result.position === "number" &&
          typeof prevComparable === "number"
        ? prevComparable - result.position
        : null;

  return {
    ...result,
    trackingTargetId: result.trackingTargetId ?? matchedTarget?.id ?? null,
    targetLabel:
      result.targetLabel ??
      (matchedTarget ? formatTargetLabel(matchedTarget) : device),
    countryCode: result.countryCode ?? matchedTarget?.countryCode ?? null,
    cityName: result.cityName ?? matchedTarget?.cityName ?? null,
    language: result.language ?? matchedTarget?.languageCode ?? null,
    previousComparablePosition: prevComparable,
    positionChange,
    comparisonMethod:
      result.comparisonMethod ??
      (prevComparable !== null ? "previous_comparable_observation" : "none"),
  };
}

export function enrichRankResults(
  results: {
    rows: RankTrackingRow[];
    run: { id: string; lastCheckedAt: string } | null;
  },
  targetById: Map<string, TargetRow>,
  singleTargetByDevice: Partial<Record<"desktop" | "mobile", TargetRow>>,
) {
  return {
    ...results,
    rows: results.rows.map((row) => ({
      ...row,
      desktop: enrichDeviceResult(
        row.desktop,
        "desktop",
        targetById,
        singleTargetByDevice,
      ),
      mobile: enrichDeviceResult(
        row.mobile,
        "mobile",
        targetById,
        singleTargetByDevice,
      ),
    })),
  };
}

export function toFlattenedRankRows(
  rows: RankTrackingRow[],
  scopedDevice?: "desktop" | "mobile",
): FlattenedRankObservationRow[] {
  const flattened: FlattenedRankObservationRow[] = [];
  for (const row of rows) {
    const devices: Array<"desktop" | "mobile"> = scopedDevice
      ? [scopedDevice]
      : ["desktop", "mobile"];
    for (const device of devices) {
      const res = row[device];
      const hasAnyData =
        res.position !== null ||
        res.previousPosition !== null ||
        res.previousComparablePosition != null ||
        res.checkedAt !== null ||
        res.checkedDate != null ||
        res.rankingUrl !== null;
      if (
        !scopedDevice &&
        !hasAnyData &&
        device === "mobile" &&
        row.desktop.position !== null
      ) {
        continue;
      }
      if (
        !scopedDevice &&
        !hasAnyData &&
        device === "desktop" &&
        row.mobile.position !== null
      ) {
        continue;
      }

      const prevComparable =
        res.previousComparablePosition !== undefined
          ? res.previousComparablePosition
          : res.previousPosition;
      const movement =
        res.positionChange !== undefined
          ? res.positionChange
          : typeof res.position === "number" &&
              typeof prevComparable === "number"
            ? prevComparable - res.position
            : null;

      flattened.push({
        keyword: row.keyword,
        target: res.targetLabel ?? device,
        device,
        position: res.position,
        obsDate: resolveObsDate(res),
        prevComparable,
        prevDate: res.previousObservationDate ?? null,
        movement,
        providerDelta: res.providerChange ?? null,
        provider: res.provider ?? null,
        provenance: resolveProvenance(res),
        comparisonMethod: res.comparisonMethod ?? "none",
        url: res.rankingUrl ?? null,
        status: res.attemptStatus ?? res.status ?? "—",
      });
    }
  }
  return flattened;
}

export const RANK_RESULT_COLUMNS: McpTableColumn<FlattenedRankObservationRow>[] =
  [
    { header: "keyword", value: (row) => row.keyword },
    { header: "target", value: (row) => row.target },
    { header: "device", value: (row) => row.device },
    { header: "pos", value: (row) => row.position },
    { header: "obs date", value: (row) => row.obsDate },
    { header: "prev comparable", value: (row) => row.prevComparable },
    { header: "prev date", value: (row) => row.prevDate },
    {
      header: "movement",
      value: (row) => row.movement,
      format: (v) => formatSignedChange(typeof v === "number" ? v : null),
    },
    {
      header: "provider delta",
      value: (row) => row.providerDelta,
      format: (v) => formatSignedChange(typeof v === "number" ? v : null),
    },
    { header: "provider", value: (row) => row.provider },
    { header: "provenance", value: (row) => row.provenance },
    { header: "method", value: (row) => row.comparisonMethod },
    { header: "url", value: (row) => row.url },
    { header: "status", value: (row) => row.status },
  ];
