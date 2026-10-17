import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import type { MutableRefObject } from "react";
import { makeSelectionColumn } from "@/client/components/table/AppDataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import type { SelectionAnchor } from "@/client/components/table/tableSelection";
import type {
  getSearchPerformanceReport,
  getSearchPerformanceTable,
} from "@/serverFunctions/searchPerformance";

export type Report = Extract<
  Awaited<ReturnType<typeof getSearchPerformanceReport>>,
  { connected: true }
>;
export type SearchPerformanceTableRow = Extract<
  Awaited<ReturnType<typeof getSearchPerformanceTable>>,
  { connected: true }
>["rows"][number];
type DimensionRow = SearchPerformanceTableRow;
type StrikingRow = Report["strikingDistance"][number];

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function formatCtr(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatPosition(value: number): string {
  return value.toFixed(1);
}

function MetricDiffCell({
  value,
  change,
  pctChange,
  prevValue,
  isPosition = false,
}: {
  value: string;
  change?: number;
  pctChange?: number | null;
  prevValue?: string;
  isPosition?: boolean;
}) {
  if (change === undefined) {
    return <span>{value}</span>;
  }
  const isImproved = change > 0;
  const isZero = change === 0;
  const colorClass = isZero
    ? "text-base-content/40"
    : isImproved
      ? "text-success font-medium"
      : "text-error font-medium";
  const sign = change > 0 ? "+" : "";

  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="font-semibold text-base-content">{value}</span>
      <span
        className={`text-[11px] ${colorClass}`}
        title={prevValue ? `Previous: ${prevValue}` : undefined}
      >
        {sign}
        {isPosition ? change.toFixed(1) : formatCount(change)}
        {pctChange !== undefined && pctChange !== null
          ? ` (${sign}${pctChange.toFixed(1)}%)`
          : ""}
      </span>
    </div>
  );
}

const rightAligned = {
  headerClassName: "text-right",
  cellClassName: "text-right tabular-nums",
} as const;

const dimensionHelper = createColumnHelper<DimensionRow>();

export function buildDimensionColumns(
  keyLabel: string,
): ColumnDef<DimensionRow>[] {
  return [
    dimensionHelper.accessor("key", {
      enableSorting: false,
      header: () => keyLabel,
      cell: ({ getValue }) => (
        <span className="block max-w-xl truncate" title={getValue()}>
          {getValue()}
        </span>
      ),
    }),
    dimensionHelper.accessor("clicks", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Clicks" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatCount(row.original.clicks)}
          change={row.original.clicksChange}
          pctChange={row.original.clicksPctChange}
          prevValue={
            row.original.prevClicks !== undefined
              ? formatCount(row.original.prevClicks)
              : undefined
          }
        />
      ),
      meta: rightAligned,
    }),
    dimensionHelper.accessor("impressions", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Impressions" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatCount(row.original.impressions)}
          change={row.original.impressionsChange}
          pctChange={row.original.impressionsPctChange}
          prevValue={
            row.original.prevImpressions !== undefined
              ? formatCount(row.original.prevImpressions)
              : undefined
          }
        />
      ),
      meta: rightAligned,
    }),
    dimensionHelper.accessor("ctr", {
      header: ({ column }) => (
        <SortableHeader column={column} label="CTR" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatCtr(row.original.ctr)}
          change={row.original.ctrChange}
          prevValue={
            row.original.prevCtr !== undefined
              ? formatCtr(row.original.prevCtr)
              : undefined
          }
        />
      ),
      meta: rightAligned,
    }),
    dimensionHelper.accessor("position", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Position" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatPosition(row.original.position)}
          change={row.original.positionChange}
          prevValue={
            row.original.prevPosition !== undefined
              ? formatPosition(row.original.prevPosition)
              : undefined
          }
          isPosition
        />
      ),
      meta: rightAligned,
    }),
  ];
}

const strikingHelper = createColumnHelper<StrikingRow>();

export function buildStrikingColumns(
  anchorRef: MutableRefObject<SelectionAnchor | null>,
): ColumnDef<StrikingRow>[] {
  return [
    makeSelectionColumn<StrikingRow>(anchorRef),
    strikingHelper.accessor("query", {
      enableSorting: false,
      header: () => "Query",
      cell: ({ getValue }) => (
        <span className="block max-w-xs truncate" title={getValue()}>
          {getValue()}
        </span>
      ),
    }),
    strikingHelper.accessor("page", {
      enableSorting: false,
      header: () => "Page",
      cell: ({ getValue }) =>
        /^https?:\/\//.test(getValue()) ? (
          <a
            href={getValue()}
            target="_blank"
            rel="noreferrer"
            className="link link-hover block max-w-sm truncate"
            title={getValue()}
          >
            {getValue()}
          </a>
        ) : (
          <span className="block max-w-sm truncate" title={getValue()}>
            {getValue()}
          </span>
        ),
    }),
    strikingHelper.accessor("impressions", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Impressions" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatCount(row.original.impressions)}
          change={row.original.impressionsChange}
          pctChange={row.original.impressionsPctChange}
          prevValue={
            row.original.prevImpressions !== undefined
              ? formatCount(row.original.prevImpressions)
              : undefined
          }
        />
      ),
      meta: rightAligned,
    }),
    strikingHelper.accessor("clicks", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Clicks" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatCount(row.original.clicks)}
          change={row.original.clicksChange}
          pctChange={row.original.clicksPctChange}
          prevValue={
            row.original.prevClicks !== undefined
              ? formatCount(row.original.prevClicks)
              : undefined
          }
        />
      ),
      meta: rightAligned,
    }),
    strikingHelper.accessor("position", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Position" align="right" />
      ),
      cell: ({ row }) => (
        <MetricDiffCell
          value={formatPosition(row.original.position)}
          change={row.original.positionChange}
          prevValue={
            row.original.prevPosition !== undefined
              ? formatPosition(row.original.prevPosition)
              : undefined
          }
          isPosition
        />
      ),
      meta: rightAligned,
    }),
  ];
}
