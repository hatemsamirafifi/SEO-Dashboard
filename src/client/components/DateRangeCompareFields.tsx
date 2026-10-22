import {
  PRESET_LABELS,
  type CompareMode,
  type DateRangePreset,
} from "@/types/schemas/date-range-compare";

/**
 * The two modal tabs of the date-range compare control. They live apart from
 * the modal shell so the shell stays readable and the tab markup can be
 * reasoned about on its own.
 */

export function DateRangeFilterTab({
  presets,
  draftRange,
  draftStartDate,
  draftEndDate,
  onRangeChange,
  onStartDateChange,
  onEndDateChange,
}: {
  presets: DateRangePreset[];
  draftRange: DateRangePreset;
  draftStartDate: string;
  draftEndDate: string;
  onRangeChange: (range: DateRangePreset) => void;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
          Date Range
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {presets.map((preset) => {
            const isChecked = draftRange === preset;
            return (
              <label
                key={preset}
                className={`flex items-center gap-2.5 rounded-lg border p-2.5 cursor-pointer text-sm transition-colors ${
                  isChecked
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-base-300 hover:bg-base-200"
                }`}
              >
                <input
                  type="radio"
                  name="date-range-preset"
                  className="radio radio-primary radio-sm"
                  checked={isChecked}
                  onChange={() => onRangeChange(preset)}
                />
                <span>{PRESET_LABELS[preset]}</span>
              </label>
            );
          })}
        </div>
      </div>

      {draftRange === "custom" ? (
        <div className="rounded-lg border border-base-300 bg-base-200/50 p-3 space-y-3">
          <div className="text-xs font-semibold text-base-content/70">
            Custom Date Range
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/60">Start Date (From)</span>
              <input
                type="date"
                className="input input-bordered input-sm"
                value={draftStartDate}
                onChange={(e) => onStartDateChange(e.target.value)}
                max={draftEndDate}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/60">End Date (To)</span>
              <input
                type="date"
                className="input input-bordered input-sm"
                value={draftEndDate}
                onChange={(e) => onEndDateChange(e.target.value)}
                min={draftStartDate}
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const COMPARE_OPTIONS = [
  { id: "none", label: "No comparison (Off)" },
  {
    id: "previous_period",
    label: "Compare to previous period",
    desc: "Compares to the period immediately preceding the selected range",
  },
  {
    id: "previous_year",
    label: "Compare to previous year (YoY)",
    desc: "Compares to the exact same period one year ago",
  },
  {
    id: "custom",
    label: "Custom comparison dates",
    desc: "Manually specify a custom comparison date window",
  },
] satisfies Array<{ id: CompareMode; label: string; desc?: string }>;

export function DateRangeCompareTab({
  draftCompareMode,
  draftCompareStartDate,
  draftCompareEndDate,
  onCompareModeChange,
  onCompareStartDateChange,
  onCompareEndDateChange,
}: {
  draftCompareMode: CompareMode;
  draftCompareStartDate: string;
  draftCompareEndDate: string;
  onCompareModeChange: (mode: CompareMode) => void;
  onCompareStartDateChange: (value: string) => void;
  onCompareEndDateChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
          Comparison Mode
        </span>
        <div className="space-y-2">
          {COMPARE_OPTIONS.map((option) => {
            const isChecked = draftCompareMode === option.id;
            return (
              <label
                key={option.id}
                className={`flex flex-col gap-1 rounded-lg border p-3 cursor-pointer text-sm transition-colors ${
                  isChecked
                    ? "border-primary bg-primary/5"
                    : "border-base-300 hover:bg-base-200"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="compare-mode"
                    className="radio radio-primary radio-sm"
                    checked={isChecked}
                    onChange={() => onCompareModeChange(option.id)}
                  />
                  <span className="font-medium">{option.label}</span>
                </div>
                {option.desc ? (
                  <span className="text-xs text-base-content/60 pl-6">
                    {option.desc}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>

      {draftCompareMode === "custom" ? (
        <div className="rounded-lg border border-base-300 bg-base-200/50 p-3 space-y-3">
          <div className="text-xs font-semibold text-base-content/70">
            Custom Comparison Period
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/60">Compare Start (From)</span>
              <input
                type="date"
                className="input input-bordered input-sm"
                value={draftCompareStartDate}
                onChange={(e) => onCompareStartDateChange(e.target.value)}
                max={draftCompareEndDate}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-base-content/60">Compare End (To)</span>
              <input
                type="date"
                className="input input-bordered input-sm"
                value={draftCompareEndDate}
                onChange={(e) => onCompareEndDateChange(e.target.value)}
                min={draftCompareStartDate}
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
