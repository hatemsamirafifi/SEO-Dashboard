import {
  GA4_ANALYTICS_DEVICES,
  type AnalyticsRange,
} from "@/types/schemas/ga4";
import { ANALYTICS_RANGE_OPTIONS } from "./analyticsCopy";

export const ALL = "ALL";

export type AnalyticsDeviceParam =
  | (typeof GA4_ANALYTICS_DEVICES)[number]
  | undefined;

export const ANALYTICS_DEVICE_OPTIONS = [
  { value: ALL, label: "All devices" },
  ...GA4_ANALYTICS_DEVICES.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  })),
] as const;

export function isAnalyticsRange(value: string): value is AnalyticsRange {
  return ANALYTICS_RANGE_OPTIONS.some((option) => option.value === value);
}

/** Narrow the raw device select value to a GA4 device param. String literal
 *  checks narrow without assertions; ALL and unknown values mean unfiltered
 *  rather than reaching the validator as garbage. */
export function toDeviceParam(value: string): AnalyticsDeviceParam {
  if (value === "desktop" || value === "mobile" || value === "tablet")
    return value;
  return undefined;
}

export type AnalyticsGoalOption = { id: string; name: string };

export type AnalyticsGoalsState =
  | { kind: "loading" }
  | { kind: "ready"; goals: AnalyticsGoalOption[] }
  | { kind: "empty" };

export function AnalyticsFilterToolbar({
  range,
  setRange,
  channel,
  setChannel,
  device,
  setDevice,
  country,
  setCountry,
  goalId,
  setGoalId,
  goalsState,
  isFetching,
}: {
  range: AnalyticsRange;
  setRange: (r: AnalyticsRange) => void;
  channel: string;
  setChannel: (c: string) => void;
  device: string;
  setDevice: (d: string) => void;
  country: string;
  setCountry: (c: string) => void;
  // Spec 010: goal filter for the conversions view. Empty string = all
  // conversions; an id scopes to that goal's stored event binding.
  goalId: string;
  setGoalId: (id: string) => void;
  // Honest select states: loading while goals load, empty (disabled with an
  // explicit note) when the project has zero active goals.
  goalsState: AnalyticsGoalsState;
  isFetching: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-base-300 px-4 py-3 lg:flex-row lg:items-center lg:gap-4">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-base-content/60">Range</span>
        <select
          className="select select-bordered select-sm"
          value={range}
          onChange={(event) => {
            if (isAnalyticsRange(event.target.value))
              setRange(event.target.value);
          }}
          aria-label="Date range"
        >
          {ANALYTICS_RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-base-content/60">Channel</span>
        <input
          className="input input-bordered input-sm w-40"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          placeholder="All channels"
          aria-label="Channel filter"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-base-content/60">Device</span>
        <select
          className="select select-bordered select-sm"
          value={device}
          onChange={(event) => setDevice(event.target.value)}
          aria-label="Device filter"
        >
          {ANALYTICS_DEVICE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-base-content/60">Country</span>
        <input
          className="input input-bordered input-sm w-40"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          placeholder="All countries"
          aria-label="Country filter"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-base-content/60">Goal</span>
        <select
          className="select select-bordered select-sm"
          value={goalId}
          onChange={(event) => setGoalId(event.target.value)}
          aria-label="Goal filter"
          disabled={goalsState.kind !== "ready"}
        >
          <option value="">All conversions</option>
          {goalsState.kind === "ready"
            ? goalsState.goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.name}
                </option>
              ))
            : null}
        </select>
        {goalsState.kind === "empty" ? (
          <span className="text-xs text-base-content/60">
            No goals yet — create one below to filter conversions.
          </span>
        ) : null}
      </label>
      {isFetching ? (
        <span className="text-sm text-base-content/60">Updating…</span>
      ) : null}
    </div>
  );
}
