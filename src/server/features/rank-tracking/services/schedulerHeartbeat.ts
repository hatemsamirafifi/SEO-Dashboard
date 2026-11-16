import { APPROVED_PILOT_CONFIG_ID } from "@/shared/rank-tracking";

let lastTickTimestamp: string | null = null;
let lastTickSuccess: boolean = true;
let lastTickError: string | null = null;
let totalTicksCount: number = 0;

export function recordSchedulerTick(
  success: boolean = true,
  error?: string | null,
) {
  lastTickTimestamp = new Date().toISOString();
  lastTickSuccess = success;
  lastTickError = error ?? null;
  totalTicksCount++;
  return {
    lastTickAt: lastTickTimestamp,
    success: lastTickSuccess,
    totalTicks: totalTicksCount,
  };
}

export function getLastSchedulerTick() {
  return lastTickTimestamp;
}

export function isSchedulerRecentlyActive(
  maxAgeMs: number = 35 * 60 * 1000,
): boolean {
  if (!lastTickTimestamp) return false;
  const elapsed = Date.now() - Date.parse(lastTickTimestamp);
  return elapsed >= 0 && elapsed <= maxAgeMs;
}

export function getSchedulerHeartbeatStatus(env?: unknown) {
  const envRecord = env as Record<string, string | undefined> | undefined;
  const pilotEnabled =
    envRecord?.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true" ||
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true";

  const rawAllowlist = envRecord?.SCHEDULED_PILOT_CONFIG_ALLOWLIST?.trim();
  const allowlist = rawAllowlist
    ? rawAllowlist
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [APPROVED_PILOT_CONFIG_ID];

  const recentlyActive = isSchedulerRecentlyActive();

  return {
    schedulerConfigured: pilotEnabled,
    schedulerRunning: recentlyActive,
    lastTickAt: lastTickTimestamp,
    lastTickSuccess,
    lastTickError,
    totalTicks: totalTicksCount,
    allowlist,
    cadence: "weekly",
  };
}
