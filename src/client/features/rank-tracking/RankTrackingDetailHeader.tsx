import {
  Globe,
  Monitor,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Settings,
  Smartphone,
} from "lucide-react";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { LOCATIONS } from "@/client/features/keywords/locations";
import {
  devicesLabel,
  scheduleLabel,
  APPROVED_PILOT_CONFIG_ID,
} from "@/shared/rank-tracking";
import { formatLocationLabel } from "@/shared/keyword-locations";
import type {
  ComparePeriod,
  RankTrackingConfig,
  RankTrackingTarget,
} from "@/types/schemas/rank-tracking";

export type DeviceViewFilter = "all" | "desktop" | "mobile";

export interface RankTrackingCostEstimate {
  keywordCount: number;
  costUsd: number | null;
  costCredits?: number | null;
  devicesCount?: number;
  targetCount?: number;
  totalChecks?: number;
  pricingModel?: "subscription_quota" | "per_serp_usd";
  provider?: "seranking" | "dataforseo";
  method?: string;
}

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
  onReadOnlySync,
  checkBusy,
  schedulerRunning,
  schedulerConfigured,
}: {
  config: RankTrackingConfig;
  run: { lastCheckedAt: string } | null | undefined;
  targets?: RankTrackingTarget[];
  selectedTargetId?: string;
  onSelectedTargetChange?: (targetId: string | undefined) => void;
  onManageTargets?: () => void;
  costEstimate: RankTrackingCostEstimate | undefined;
  hasBothDevices: boolean;
  activeDevice: DeviceViewFilter;
  onActiveDeviceChange: (v: DeviceViewFilter) => void;
  comparePeriod: ComparePeriod;
  onComparePeriodChange: (v: ComparePeriod) => void;
  onEdit: () => void;
  onToggleAddKeywords: () => void;
  onReadOnlySync?: () => void;
  checkBusy?: boolean;
  schedulerRunning?: boolean;
  schedulerConfigured?: boolean;
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
          {config.nextCheckAt && config.isActive && (
            <>
              {" "}
              &middot; Next: {new Date(config.nextCheckAt).toLocaleDateString()}
            </>
          )}
          {!config.isActive && (
            <>
              {" "}
              &middot; <span className="text-warning font-medium">Paused</span>
            </>
          )}
          {run && (
            <>
              {" "}
              &middot; Last: {new Date(run.lastCheckedAt).toLocaleDateString()}
            </>
          )}
          {config.lastSkipReason && (
            <span
              className="text-warning font-normal ml-1"
              title={`Last scheduled sync was skipped: ${config.lastSkipReason}`}
            >
              &middot; Skip: {config.lastSkipReason}
            </span>
          )}
          {typeof schedulerRunning === "boolean" &&
            (schedulerRunning ? (
              <span
                className="badge badge-xs badge-success badge-outline gap-1 text-[10px] ml-1.5 align-middle"
                title="Automatic Docker scheduler daemon is actively running"
              >
                <span className="size-1 rounded-full bg-success animate-pulse" />
                Auto-Sync Active
              </span>
            ) : schedulerConfigured ? (
              <span
                className="badge badge-xs badge-ghost border-base-300 gap-1 text-[10px] ml-1.5 align-middle"
                title="Pilot enabled in configuration; awaiting Docker scheduler heartbeat"
              >
                <span className="size-1 rounded-full bg-base-content/40" />
                Auto-Sync Configured
              </span>
            ) : (
              <span
                className="badge badge-xs badge-ghost border-dashed border-base-300 text-base-content/50 text-[10px] ml-1.5 align-middle"
                title="Scheduled tracking pilot is disabled in environment"
              >
                Auto-Sync Disabled
              </span>
            ))}
          {costEstimate && costEstimate.keywordCount > 0 && (
            <>
              {" "}
              &middot;{" "}
              {costEstimate.pricingModel === "subscription_quota" ||
              costEstimate.provider === "seranking" ? (
                <>
                  <span
                    className="font-medium text-base-content/70"
                    title={
                      config.id === APPROVED_PILOT_CONFIG_ID
                        ? "Full configuration capacity: 98 keywords across 2 targets = 196 keyword-target checks (subscription quota)"
                        : "Estimated keyword-target checks against SE Ranking subscription quota"
                    }
                  >
                    ~
                    {costEstimate.totalChecks ??
                      costEstimate.keywordCount *
                        (costEstimate.devicesCount ?? 1)}{" "}
                    {config.id === APPROVED_PILOT_CONFIG_ID
                      ? "checks capacity"
                      : "checks/run"}{" "}
                    (subscription quota)
                  </span>
                  {config.id === APPROVED_PILOT_CONFIG_ID && (
                    <span
                      className="badge badge-xs badge-info badge-outline font-normal ml-1"
                      title="Scheduled read-only pilot scope: exactly 1 keyword across 2 targets = 2 observation pairs via GET synchronization (0 paid recheck POSTs)"
                    >
                      pilot scope: 2 pairs (read-only)
                    </span>
                  )}
                </>
              ) : typeof costEstimate.costUsd === "number" &&
                costEstimate.costUsd > 0 ? (
                <span>~${costEstimate.costUsd.toFixed(2)}/check</span>
              ) : (
                <span>
                  ~
                  {costEstimate.totalChecks ??
                    costEstimate.keywordCount *
                      (costEstimate.devicesCount ?? 1)}{" "}
                  checks/run
                </span>
              )}
            </>
          )}
        </p>
        {targets && targets.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5 mt-1.5"
            role="toolbar"
            aria-label="Target view filters"
          >
            {onSelectedTargetChange && (
              <button
                type="button"
                className={`btn btn-xs h-6 min-h-0 px-2 text-[11px] ${
                  !selectedTargetId
                    ? "btn-primary"
                    : "btn-ghost border border-base-300"
                }`}
                title="View filter: Show keywords across all targets (does not alter background tracking scope)"
                aria-label="View all targets"
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
                  title={`View filter: Filter displayed keywords by target ${t.searchEngine} / ${label} (does not alter background tracking scope)`}
                  aria-label={`View target filter ${label}`}
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
                  title={`Target: ${t.searchEngine} / ${label}`}
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
          <div
            className="flex items-center gap-1"
            title="View filter: Display Desktop or Mobile results (does not change check scope or tracking configuration)"
            aria-label="Device view filter"
          >
            <span className="text-[11px] font-medium text-base-content/50 uppercase tracking-wider hidden sm:inline">
              View:
            </span>
            <SegmentedToggle<DeviceViewFilter>
              items={[
                {
                  value: "all",
                  icon: <MonitorSmartphone className="size-3.5" />,
                  label: "All devices",
                },
                {
                  value: "desktop",
                  icon: <Monitor className="size-3.5" />,
                  label: "Desktop only",
                },
                {
                  value: "mobile",
                  icon: <Smartphone className="size-3.5" />,
                  label: "Mobile only",
                },
              ]}
              value={activeDevice}
              onChange={onActiveDeviceChange}
            />
          </div>
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
        {onReadOnlySync && (
          <button
            type="button"
            className="btn btn-outline btn-sm gap-1"
            onClick={onReadOnlySync}
            disabled={checkBusy}
            title="Fetch daily ranking observations from SE Ranking without initiating a paid recheck (0 credits)"
          >
            <RefreshCw
              className={`size-3.5 ${checkBusy ? "animate-spin" : ""}`}
            />
            Sync Rankings
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
