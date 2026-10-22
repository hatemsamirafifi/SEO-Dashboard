/** Shared constants for the GA4 e2e fixture payloads. */

export const FIXTURE_PROPERTY_ID = "properties/987654321";
export const DEFAULT_WINDOWS = {
  current: { from: "2026-09-18", to: "2026-10-15" },
  previous: { from: "2026-08-21", to: "2026-09-17" },
};
export const DEFAULT_COVERAGE = {
  status: "complete" as const,
  coveredDates: 28,
  totalDates: 28,
  coveredThrough: "2026-10-15",
};
