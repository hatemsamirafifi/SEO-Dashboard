import { useState, useId } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import {
  DateRangeCompareTab,
  DateRangeFilterTab,
} from "@/client/components/DateRangeCompareFields";
import {
  PRESET_LABELS,
  type CompareMode,
  type DateRangePreset,
  resolveDateWindows,
} from "@/types/schemas/date-range-compare";

export type DateRangeCompareValues = {
  range: DateRangePreset;
  startDate?: string;
  endDate?: string;
  compareMode: CompareMode;
  compareStartDate?: string;
  compareEndDate?: string;
};

const DEFAULT_PRESETS: DateRangePreset[] = [
  "last_7_days",
  "last_28_days",
  "last_30_days",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "last_16_months",
  "custom",
];

export function formatTriggerLabel(values: {
  range: DateRangePreset;
  startDate?: string;
  endDate?: string;
  compareMode?: CompareMode;
  compareStartDate?: string;
  compareEndDate?: string;
}): string {
  const { range, startDate, endDate, compareMode } = values;
  let baseLabel: string;
  if (range === "custom" && startDate && endDate) {
    baseLabel = `${startDate} – ${endDate}`;
  } else {
    baseLabel = PRESET_LABELS[range] ?? "Date range";
  }

  if (!compareMode || compareMode === "none") {
    return baseLabel;
  }

  if (compareMode === "previous_period") {
    return `${baseLabel} vs Previous period`;
  }
  if (compareMode === "previous_year") {
    return `${baseLabel} vs Previous year`;
  }
  if (
    compareMode === "custom" &&
    values.compareStartDate &&
    values.compareEndDate
  ) {
    return `${baseLabel} vs ${values.compareStartDate} – ${values.compareEndDate}`;
  }

  return `${baseLabel} vs Compare`;
}

export function DateRangeCompareModal({
  range,
  startDate,
  endDate,
  compareMode = "none",
  compareStartDate,
  compareEndDate,
  presets = DEFAULT_PRESETS,
  onApply,
  buttonClassName = "btn btn-outline btn-sm gap-2 font-normal",
}: {
  range: DateRangePreset;
  startDate?: string;
  endDate?: string;
  compareMode?: CompareMode;
  compareStartDate?: string;
  compareEndDate?: string;
  presets?: DateRangePreset[];
  onApply: (values: DateRangeCompareValues) => void;
  buttonClassName?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"filter" | "compare">("filter");

  // Draft state for modal edits
  const [draftRange, setDraftRange] = useState<DateRangePreset>(range);
  const [draftStartDate, setDraftStartDate] = useState<string>(
    startDate ||
      new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10),
  );
  const [draftEndDate, setDraftEndDate] = useState<string>(
    endDate || new Date().toISOString().slice(0, 10),
  );
  const [draftCompareMode, setDraftCompareMode] =
    useState<CompareMode>(compareMode);
  const [draftCompareStartDate, setDraftCompareStartDate] = useState<string>(
    compareStartDate ||
      new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10),
  );
  const [draftCompareEndDate, setDraftCompareEndDate] = useState<string>(
    compareEndDate ||
      new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
  );

  const filterTabId = useId();
  const compareTabId = useId();

  const openModal = () => {
    setDraftRange(range);
    setDraftStartDate(
      startDate ||
        new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10),
    );
    setDraftEndDate(endDate || new Date().toISOString().slice(0, 10));
    setDraftCompareMode(compareMode || "none");
    setDraftCompareStartDate(
      compareStartDate ||
        new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10),
    );
    setDraftCompareEndDate(
      compareEndDate ||
        new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
    );
    setActiveTab("filter");
    setIsOpen(true);
  };

  const handleApply = () => {
    onApply({
      range: draftRange,
      startDate: draftRange === "custom" ? draftStartDate : undefined,
      endDate: draftRange === "custom" ? draftEndDate : undefined,
      compareMode: draftCompareMode,
      compareStartDate:
        draftCompareMode === "custom" ? draftCompareStartDate : undefined,
      compareEndDate:
        draftCompareMode === "custom" ? draftCompareEndDate : undefined,
    });
    setIsOpen(false);
  };

  const triggerLabel = formatTriggerLabel({
    range,
    startDate,
    endDate,
    compareMode,
    compareStartDate,
    compareEndDate,
  });

  // Calculate preview of resolved windows
  const previewWindows = resolveDateWindows({
    dateRange: draftRange,
    startDate: draftStartDate,
    endDate: draftEndDate,
    compareMode: draftCompareMode,
    compareStartDate: draftCompareStartDate,
    compareEndDate: draftCompareEndDate,
  });

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        onClick={openModal}
        aria-label="Filter date range and comparison"
      >
        <Calendar className="size-4 shrink-0 text-base-content/70" />
        <span className="truncate max-w-[240px] sm:max-w-none">
          {triggerLabel}
        </span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </button>

      {isOpen ? (
        <Modal
          maxWidth="max-w-lg"
          onClose={() => setIsOpen(false)}
          labelledBy={filterTabId}
        >
          {/* Header tabs matching Google Search Console */}
          <div className="border-b border-base-300 pb-2">
            <div role="tablist" className="tabs tabs-boxed bg-base-200">
              <button
                type="button"
                role="tab"
                id={filterTabId}
                aria-selected={activeTab === "filter"}
                className={`tab flex-1 font-semibold ${
                  activeTab === "filter" ? "tab-active" : ""
                }`}
                onClick={() => setActiveTab("filter")}
              >
                FILTER
              </button>
              <button
                type="button"
                role="tab"
                id={compareTabId}
                aria-selected={activeTab === "compare"}
                className={`tab flex-1 font-semibold ${
                  activeTab === "compare" ? "tab-active" : ""
                }`}
                onClick={() => setActiveTab("compare")}
              >
                COMPARE
                {draftCompareMode !== "none" ? (
                  <span className="badge badge-xs badge-primary ml-2">ON</span>
                ) : null}
              </button>
            </div>
          </div>

          {activeTab === "filter" ? (
            <DateRangeFilterTab
              presets={presets}
              draftRange={draftRange}
              draftStartDate={draftStartDate}
              draftEndDate={draftEndDate}
              onRangeChange={setDraftRange}
              onStartDateChange={setDraftStartDate}
              onEndDateChange={setDraftEndDate}
            />
          ) : (
            <DateRangeCompareTab
              draftCompareMode={draftCompareMode}
              draftCompareStartDate={draftCompareStartDate}
              draftCompareEndDate={draftCompareEndDate}
              onCompareModeChange={setDraftCompareMode}
              onCompareStartDateChange={setDraftCompareStartDate}
              onCompareEndDateChange={setDraftCompareEndDate}
            />
          )}
          {/* Active Period Preview Footer info */}
          <div className="rounded-md bg-base-200 p-2.5 text-xs text-base-content/70 flex flex-col gap-1">
            <div>
              <span className="font-semibold">Selected Window:</span>{" "}
              {previewWindows.current.startDate} to{" "}
              {previewWindows.current.endDate}
            </div>
            {previewWindows.compare ? (
              <div>
                <span className="font-semibold text-primary">
                  Comparison Window:
                </span>{" "}
                {previewWindows.compare.startDate} to{" "}
                {previewWindows.compare.endDate}
              </div>
            ) : null}
          </div>

          {/* Modal Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-base-300">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleApply}
            >
              Apply
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
