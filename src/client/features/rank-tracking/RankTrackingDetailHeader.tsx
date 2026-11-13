import { Globe, Monitor, Plus, Settings, Smartphone } from "lucide-react";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { LOCATIONS } from "@/client/features/keywords/locations";
import { devicesLabel, scheduleLabel } from "@/shared/rank-tracking";
import { formatLocationLabel } from "@/shared/keyword-locations";
import type {
  ComparePeriod,
  RankTrackingConfig,
  RankTrackingTarget,
} from "@/types/schemas/rank-tracking";

const COMPARE_PERIODS: ReadonlySet<string> = new Set([
  "1d",
  "7d",
  "30d",
  "90d",
]);
function isComparePeriod(v: string): v is ComparePeriod {
  return COMPARE_PERIODS.has(v);
}

export function RankTrackingDetailHeader({
  config,
  run,
  targets,
  selectedTargetId,
  onSelectedTargetChange,
  onManageTargets,
  costEstimate,
  hasBothDevices,
  activeDevice,
  onActiveDeviceChange,
  comparePeriod,
  onComparePeriodChange,
  onEdit,
  onToggleAddKeywords,
}: {
  config: RankTrackingConfig;
  run: { lastCheckedAt: string } | null | undefined;
  targets?: RankTrackingTarget[];
  selectedTargetId?: string;
  onSelectedTargetChange?: (targetId: string | undefined) => void;
  onManageTargets?: () => void;
  costEstimate: { keywordCount: number; costUsd: number } | undefined;
  hasBothDevices: boolean;
  activeDevice: "desktop" | "mobile";
  onActiveDeviceChange: (v: "desktop" | "mobile") => void;
  comparePeriod: ComparePeriod;
  onComparePeriodChange: (v: ComparePeriod) => void;
  onEdit: () => void;
  onToggleAddKeywords: () => void;
}) {
  const activeTargets = (targets ?? []).filter((t) => t.enabled);
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 px-4 pt-4 pb-3">
      <div>
        <h2 className="text-lg font-semibold">{config.domain}</h2>
        <p className="text-xs text-base-content/60">
          {config.locationName
            ? formatLocationLabel(config.locationName, 2)
            : (LOCATIONS[config.locationCode] ?? "US")}{" "}
          &middot; {devicesLabel(config.devices)} &middot;{" "}
          {scheduleLabel(config.scheduleInterval)}
          {run && (
            <>
              {" "}
              &middot; Last: {new Date(run.lastCheckedAt).toLocaleDateString()}
            </>
          )}
          {costEstimate && costEstimate.keywordCount > 0 && (
            <> &middot; ~${costEstimate.costUsd.toFixed(2)}/check</>
          )}
        </p>
        {targets && targets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {onSelectedTargetChange && (
              <button
                type="button"
                className={`btn btn-xs h-6 min-h-0 px-2 text-[11px] ${
                  !selectedTargetId
                    ? "btn-primary"
                    : "btn-ghost border border-base-300"
                }`}
                onClick={() => onSelectedTargetChange(undefined)}
              >
                All targets
              </button>
            )}
            {activeTargets.map((t) => {
              const isSelected = selectedTargetId === t.id;
              const label = `${t.countryCode.toUpperCase()}${t.cityName ? ` · ${t.cityName}` : " · Countrywide"} (${t.languageCode}) · ${t.device}`;
              return onSelectedTargetChange ? (
                <button
                  key={t.id}
                  type="button"
                  className={`btn btn-xs h-6 min-h-0 px-2 text-[11px] font-medium ${
                    isSelected
                      ? "btn-primary"
                      : "btn-ghost border border-base-300"
                  }`}
                  title={`${t.searchEngine} / ${label}`}
                  onClick={() =>
                    onSelectedTargetChange(isSelected ? undefined : t.id)
                  }
                >
                  {label}
                </button>
              ) : (
                <span
                  key={t.id}
                  className="badge badge-xs badge-ghost border border-base-300 text-[10px] font-medium"
                  title={`${t.searchEngine} / ${label}`}
                >
                  {label}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {hasBothDevices && (
          <SegmentedToggle
            items={[
              {
                value: "desktop" as const,
                icon: <Monitor className="size-3.5" />,
                label: "Desktop",
              },
              {
                value: "mobile" as const,
                icon: <Smartphone className="size-3.5" />,
                label: "Mobile",
              },
            ]}
            value={activeDevice}
            onChange={onActiveDeviceChange}
          />
        )}
        <select
          className="select select-bordered select-sm text-xs w-auto"
          title="Comparison period"
          value={comparePeriod}
          onChange={(e) => {
            if (isComparePeriod(e.target.value))
              onComparePeriodChange(e.target.value);
          }}
        >
          <option value="1d">vs yesterday</option>
          <option value="7d">vs last week</option>
          <option value="30d">vs last month</option>
          <option value="90d">vs 90 days ago</option>
        </select>
        <div className="hidden sm:block h-6 w-px bg-base-300" />
        {onManageTargets && (
          <button
            type="button"
            className="btn btn-sm gap-1"
            onClick={onManageTargets}
          >
            <Globe className="size-3.5" />
            Targets
          </button>
        )}
        <button className="btn btn-sm gap-1" onClick={onEdit}>
          <Settings className="size-3.5" />
          Configure
        </button>
        <button
          className="btn btn-primary btn-sm gap-1"
          onClick={onToggleAddKeywords}
        >
          <Plus className="size-3.5" />
          Add Keywords
        </button>
      </div>
    </div>
  );
}
