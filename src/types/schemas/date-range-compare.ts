import { z } from "zod";

export const DATE_RANGE_PRESETS = [
  "last_7_days",
  "last_28_days",
  "last_30_days",
  "last_90_days",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "last_16_months",
  "custom",
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const PRESET_DAYS: Record<Exclude<DateRangePreset, "custom">, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_30_days: 30,
  last_90_days: 90,
  last_3_months: 90,
  last_6_months: 180,
  last_12_months: 365,
  last_16_months: 480,
};

export const COMPARE_MODES = [
  "none",
  "previous_period",
  "previous_year",
  "custom",
] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];

export const PRESET_LABELS: Record<DateRangePreset, string> = {
  last_7_days: "Last 7 days",
  last_28_days: "Last 28 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  last_12_months: "Last 12 months",
  last_16_months: "Last 16 months",
  custom: "Custom",
};

export const dateRangeCompareSchemaShape = {
  dateRange: z.enum(DATE_RANGE_PRESETS).default("last_28_days"),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  compareMode: z.enum(COMPARE_MODES).default("none"),
  compareStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  compareEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
};

/** Helper to add/subtract days in UTC ISO string format YYYY-MM-DD */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Helper to subtract 1 year in UTC ISO string format */
export function subtractYearIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const prevYear = y - 1;
  // Handle Feb 29 on leap years
  if (m === 2 && d === 29) {
    return `${prevYear}-02-28`;
  }
  return `${prevYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function daysBetweenIso(from: string, to: string): number {
  const t1 = Date.parse(`${from}T00:00:00.000Z`);
  const t2 = Date.parse(`${to}T00:00:00.000Z`);
  return Math.max(1, Math.round((t2 - t1) / (24 * 60 * 60 * 1000)) + 1);
}

export type ResolvedDateWindows = {
  current: { startDate: string; endDate: string };
  compare?: { startDate: string; endDate: string };
};

/** Resolve current and comparison date windows deterministically. */
export function resolveDateWindows(
  input: {
    dateRange?: DateRangePreset;
    startDate?: string;
    endDate?: string;
    compareMode?: CompareMode;
    compareStartDate?: string;
    compareEndDate?: string;
  },
  todayIso: string = new Date().toISOString().slice(0, 10),
): ResolvedDateWindows {
  const range = input.dateRange ?? "last_28_days";
  let currentStart: string;
  let currentEnd: string;

  if (range === "custom" && input.startDate && input.endDate) {
    currentStart = input.startDate;
    currentEnd = input.endDate;
    if (currentStart > currentEnd) {
      currentStart = input.endDate;
      currentEnd = input.startDate;
    }
  } else {
    const days = range === "custom" ? 28 : (PRESET_DAYS[range] ?? 28);
    currentEnd = todayIso;
    currentStart = addDaysIso(todayIso, -(days - 1));
  }

  const compareMode = input.compareMode ?? "none";
  if (compareMode === "none") {
    return { current: { startDate: currentStart, endDate: currentEnd } };
  }

  if (
    compareMode === "custom" &&
    input.compareStartDate &&
    input.compareEndDate
  ) {
    let cStart = input.compareStartDate;
    let cEnd = input.compareEndDate;
    if (cStart > cEnd) {
      cStart = input.compareEndDate;
      cEnd = input.compareStartDate;
    }
    return {
      current: { startDate: currentStart, endDate: currentEnd },
      compare: { startDate: cStart, endDate: cEnd },
    };
  }

  if (compareMode === "previous_year") {
    return {
      current: { startDate: currentStart, endDate: currentEnd },
      compare: {
        startDate: subtractYearIso(currentStart),
        endDate: subtractYearIso(currentEnd),
      },
    };
  }

  // previous_period: identical number of preceding days
  const durationDays = daysBetweenIso(currentStart, currentEnd);
  const prevEnd = addDaysIso(currentStart, -1);
  const prevStart = addDaysIso(prevEnd, -(durationDays - 1));
  return {
    current: { startDate: currentStart, endDate: currentEnd },
    compare: { startDate: prevStart, endDate: prevEnd },
  };
}
