import type { GscDailyFact } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";

/**
 * Shared GSC window math for detectors (final-plan §4). Windows anchor at
 * the latest available fact date (deterministic, testable — never wall
 * clock). Coverage is a day-presence ratio: GSC has no SUCCESS_* vocabulary,
 * so "required grain ≥80%" means distinct fact days ÷ window days.
 */

export type GscWindow = { from: string; to: string };

function parseDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${date}`);
  return ms;
}

export function addDaysISO(date: string, delta: number): string {
  return new Date(parseDay(date) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Current + previous adjacent windows of `windowDays` ending at latestDate. */
export function splitWindows(
  latestDate: string,
  windowDays: number,
): { current: GscWindow; previous: GscWindow } {
  const currentTo = latestDate;
  const currentFrom = addDaysISO(latestDate, -(windowDays - 1));
  const previousTo = addDaysISO(currentFrom, -1);
  const previousFrom = addDaysISO(previousTo, -(windowDays - 1));
  return {
    current: { from: currentFrom, to: currentTo },
    previous: { from: previousFrom, to: previousTo },
  };
}

/** N consecutive windows ending at latestDate, newest first. */
export function consecutiveWindows(
  latestDate: string,
  windowDays: number,
  count: number,
): GscWindow[] {
  const windows: GscWindow[] = [];
  let end = latestDate;
  for (let i = 0; i < count; i += 1) {
    const from = addDaysISO(end, -(windowDays - 1));
    windows.push({ from, to: end });
    end = addDaysISO(from, -1);
  }
  return windows;
}

export function inWindow(date: string, window: GscWindow): boolean {
  return date >= window.from && date <= window.to;
}

/** Inclusive day count of a window. */
export function windowDayCount(window: GscWindow): number {
  return Math.round((parseDay(window.to) - parseDay(window.from)) / 86_400_000) + 1;
}

/** Sorted distinct fact dates inside a window. */
export function distinctDatesIn(
  rows: GscDailyFact[],
  window: GscWindow,
): string[] {
  const dates = new Set<string>();
  for (const row of rows) {
    if (inWindow(row.date, window)) dates.add(row.date);
  }
  return [...dates].toSorted();
}

/** Day-presence ratio of rows inside a window (0–1). */
export function coverageRatio(
  rows: GscDailyFact[],
  window: GscWindow,
): number {
  return distinctDatesIn(rows, window).length / windowDayCount(window);
}

export function sumWindow(
  rows: GscDailyFact[],
  window: GscWindow,
): { clicks: number; impressions: number; days: number } {
  let clicks = 0;
  let impressions = 0;
  const dates = new Set<string>();
  for (const row of rows) {
    if (!inWindow(row.date, window)) continue;
    clicks += row.clicks;
    impressions += row.impressions;
    dates.add(row.date);
  }
  return { clicks, impressions, days: dates.size };
}
