import { Download, Loader2, Sheet } from "lucide-react";
import {
  GSC_DEVICES,
  SEARCH_PERFORMANCE_RANGES,
  type SearchPerformanceDateRange,
  type SearchPerformanceDevice,
} from "@/types/schemas/search-performance";
import { TableExportMenu } from "@/client/components/table/TableBulkActionBar";
import type { ExportTarget } from "@/client/features/search-performance/SearchPerformanceParts";

export const ALL = "ALL";

export type Tab = "striking" | "queries" | "pages";

const RANGE_LABELS: Record<SearchPerformanceDateRange, string> = {
  last_7_days: "Last 7 days",
  last_28_days: "Last 28 days",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  last_12_months: "Last 12 months",
  last_16_months: "Last 16 months",
};
const RANGE_OPTIONS = SEARCH_PERFORMANCE_RANGES.map((value) => ({
  value,
  label: RANGE_LABELS[value],
}));

const DEVICE_LABELS: Record<SearchPerformanceDevice, string> = {
  DESKTOP: "Desktop",
  MOBILE: "Mobile",
  TABLET: "Tablet",
};
const DEVICE_OPTIONS = GSC_DEVICES.map((value) => ({
  value,
  label: DEVICE_LABELS[value],
}));

export function isDateRange(value: string): value is SearchPerformanceDateRange {
  return SEARCH_PERFORMANCE_RANGES.some((option) => option === value);
}

export function isDevice(value: string): value is SearchPerformanceDevice {
  return GSC_DEVICES.some((option) => option === value);
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      role="tab"
      type="button"
      className={`tab font-medium ${active ? "tab-active font-semibold" : ""}`}
      onClick={onClick}
      aria-selected={active}
    >
      {label}
    </button>
  );
}

export function SearchPerformanceFilterToolbar({
  tab,
  setTab,
  strikingCount,
  isFetching,
  device,
  setDevice,
  country,
  setCountry,
  countryOptions,
  range,
  setRange,
  onExport,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  strikingCount: number;
  isFetching: boolean;
  device: SearchPerformanceDevice | typeof ALL;
  setDevice: (d: SearchPerformanceDevice | typeof ALL) => void;
  country: string;
  setCountry: (c: string) => void;
  countryOptions: Array<{ key: string }>;
  range: SearchPerformanceDateRange;
  setRange: (r: SearchPerformanceDateRange) => void;
  onExport: (target: ExportTarget) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div role="tablist" className="tabs tabs-border w-fit">
        <TabButton
          active={tab === "striking"}
          onClick={() => setTab("striking")}
          label={`Striking distance (${strikingCount})`}
        />
        <TabButton
          active={tab === "queries"}
          onClick={() => setTab("queries")}
          label="Queries"
        />
        <TabButton
          active={tab === "pages"}
          onClick={() => setTab("pages")}
          label="Pages"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isFetching ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
        <select
          className="select select-bordered select-sm w-36"
          value={device}
          onChange={(event) => {
            setDevice(
              isDevice(event.target.value) ? event.target.value : ALL,
            );
          }}
          aria-label="Device filter"
        >
          <option value={ALL}>All devices</option>
          {DEVICE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-36"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          aria-label="Country filter"
        >
          <option value={ALL}>All countries</option>
          {countryOptions.map((row) => (
            <option key={row.key} value={row.key}>
              {row.key.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-40"
          value={range}
          onChange={(event) => {
            if (isDateRange(event.target.value)) {
              setRange(event.target.value);
            }
          }}
          aria-label="Date range"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <TableExportMenu
          buttonClassName="btn btn-ghost btn-sm gap-1"
          actions={[
            {
              label: "Export to Sheets",
              icon: <Sheet className="size-4" />,
              onClick: () => onExport("sheets"),
            },
            {
              label: "Download CSV",
              icon: <Download className="size-4" />,
              onClick: () => onExport("csv"),
            },
          ]}
        />
      </div>
    </div>
  );
}
