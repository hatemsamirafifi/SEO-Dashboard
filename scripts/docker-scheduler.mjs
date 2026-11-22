#!/usr/bin/env node
/**
 * Lightweight Docker Scheduler Service for OpenSEO Local Runtime.
 *
 * Runs inside the local Docker network (or as a local background daemon),
 * invoking OpenSEO's internal scheduled rank check handler on a regular cadence (default: every 15 minutes).
 *
 * Security & Hardening:
 * - Communicates strictly over internal Docker network (or loopback).
 * - Requires a non-empty LOCAL_SCHEDULER_SECRET; fails closed if unset.
 * - Never prints or leaks secrets in logs or diagnostics.
 * - Defaults to disabled unless SCHEDULED_RANK_TRACKING_PILOT_ENABLED=true is explicitly set.
 * - Enforces client-side non-overlapping execution locks.
 * - Graceful retry on server unavailability and clean SIGTERM/SIGINT shutdown.
 */

const APP_URL = (process.env.APP_URL || "http://open-seo-dev:3001").replace(
  /\/$/,
  "",
);
const INTERVAL_SECONDS = Math.max(
  30,
  parseInt(process.env.SCHEDULER_INTERVAL_SECONDS || "900", 10),
);
const SECRET = (process.env.LOCAL_SCHEDULER_SECRET || "").trim();
const PILOT_ENABLED =
  process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true";

let isShuttingDown = false;
let isTickRunning = false;
let timerId = null;

function log(msg, ...args) {
  const ts = new Date().toISOString();
  console.log(`[docker-scheduler ${ts}] ${msg}`, ...args);
}

function errorLog(msg, ...args) {
  const ts = new Date().toISOString();
  console.error(`[docker-scheduler ${ts}] ERROR: ${msg}`, ...args);
}

async function checkServerStatus() {
  try {
    const res = await fetch(`${APP_URL}/api/internal/cron/status`, {
      headers: { "x-local-scheduler-key": SECRET },
    });
    return { ok: res.status === 200, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function waitForServer(maxAttempts = 60, delayMs = 3000) {
  log(`Waiting for OpenSEO application at ${APP_URL}...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isShuttingDown) return false;
    const result = await checkServerStatus();
    if (result.ok || result.status === 401) {
      log(
        `Connected to OpenSEO server (attempt ${attempt}, status ${result.status}).`,
      );
      return true;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  errorLog(
    `Could not connect to OpenSEO server after ${maxAttempts} attempts.`,
  );
  return false;
}

async function triggerScheduledTick() {
  if (isShuttingDown) return;

  if (!PILOT_ENABLED) {
    log(
      "Scheduled pilot is disabled (SCHEDULED_RANK_TRACKING_PILOT_ENABLED !== 'true'). Skipping tick dispatch.",
    );
    scheduleNextTick();
    return;
  }

  if (isTickRunning) {
    log(
      "Previous scheduled tick is still in progress. Skipping overlapping invocation.",
    );
    scheduleNextTick();
    return;
  }

  isTickRunning = true;
  log(
    `Triggering scheduled rank check tick... (interval: ${INTERVAL_SECONDS}s)`,
  );

  try {
    const res = await fetch(`${APP_URL}/api/internal/cron/trigger`, {
      method: "POST",
      headers: {
        "x-local-scheduler-key": SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        triggerSource: "docker-scheduler",
        timestamp: new Date().toISOString(),
      }),
    });

    const statusText = `HTTP ${res.status}`;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }

    if (res.ok) {
      log(`Tick succeeded (${statusText}):`, data);
    } else if (res.status === 409) {
      log(
        `Tick skipped: Another run is already executing on server (${statusText}):`,
        data,
      );
    } else {
      errorLog(`Tick returned error (${statusText}):`, data);
    }
  } catch (err) {
    errorLog(`Failed to dispatch tick request: ${err.message}`);
  } finally {
    isTickRunning = false;
  }

  scheduleNextTick();
}

function scheduleNextTick() {
  if (isShuttingDown) return;
  const nextMs = INTERVAL_SECONDS * 1000;
  const nextDate = new Date(Date.now() + nextMs).toISOString();
  log(`Next scheduled tick at: ${nextDate}`);
  timerId = setTimeout(() => {
    void triggerScheduledTick();
  }, nextMs);
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("Shutting down Docker scheduler service gracefully...");
  if (timerId) clearTimeout(timerId);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  log(`Starting OpenSEO Docker Scheduler Service...`);
  log(`Target App URL: ${APP_URL}`);
  log(
    `Cadence Interval: ${INTERVAL_SECONDS} seconds (~${Math.round(INTERVAL_SECONDS / 60)} minutes)`,
  );
  log(`Pilot Mode Enabled in Environment: ${PILOT_ENABLED}`);

  // Enforce required secret configuration (fail-closed)
  if (!SECRET) {
    errorLog(
      "LOCAL_SCHEDULER_SECRET is not configured or empty. The scheduler service requires an explicit secret to authenticate. Exiting.",
    );
    process.exit(1);
  }

  const serverReady = await waitForServer();
  if (!serverReady) {
    errorLog("Exiting: Server is unreachable after maximum startup wait time.");
    process.exit(1);
  }

  if (!PILOT_ENABLED) {
    log(
      "Scheduler is in monitoring-only mode (pilot disabled). Ticks will not be dispatched.",
    );
    scheduleNextTick();
    return;
  }

  // Run initial tick on startup, then schedule subsequent ticks
  await triggerScheduledTick();
}

void main();
