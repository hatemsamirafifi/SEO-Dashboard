// Durable Google Ads sync orchestration (master-plan phase 7). One
// coordination pass: resolve the connection, claim a durable run (coalescing
// overlapping workers), plan per-day/per-grain units, replay only pending
// units (committed successes are never re-fetched), fetch each pending unit
// through the fixed daily reporting reads, publish each unit atomically
// behind the live connection fence, and finalize from the durable ledger.
// Retry is reserved for the documented transient classes; auth, access,
// quota and fence loss halt the run immediately. Errors, results and logs
// are always bounded — no upstream bodies, ids or credentials.
//
// IMPORTER CONTRACT (googleAdsSyncFetch/googleAdsSyncUnits): the fetch and
// unit-pipeline modules resolve live repositories; tests that fake Google
// calls inject a client via GoogleAdsSyncServiceOptions and control retry
// timing through retryBaseDelayMs.

import { createGoogleAdsClient } from "@/server/lib/googleAdsClient";
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnection,
} from "../repositories/GoogleAdsConnectionRepository";
import {
  GoogleAdsSyncRepository,
  type GoogleAdsSyncMode,
  type GoogleAdsSyncRunPublic,
  type GoogleAdsUnitPlan,
} from "../repositories/GoogleAdsSyncRepository";
import { GOOGLE_ADS_GRAINS } from "../repositories/googleAdsAnalyticsModel";
import type { GoogleAdsFactsClient } from "./googleAdsSyncFetch";
import {
  GOOGLE_ADS_SYNC_LEASE_SECONDS,
  GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS,
  clampGoogleAdsSyncWindow,
  eachGoogleAdsDay,
  googleAdsLastFullyCoveredDate,
  googleAdsSyncToday,
  resolveGoogleAdsSyncWindow,
} from "./googleAdsSyncUtils";
import { runPendingUnits } from "./googleAdsSyncUnits";

export type GoogleAdsSyncServiceOptions = {
  projectId: string;
  organizationId: string;
  /** Defaults to "manual". The cron entry passes "scheduled". */
  mode?: GoogleAdsSyncMode;
  /** Explicit window (both dates required); clamped into the bounded sync
   *  window when given. */
  startDate?: string;
  endDate?: string;
  /** Testability seams. */
  createClient?: (
    input: Parameters<typeof createGoogleAdsClient>[0],
  ) => GoogleAdsFactsClient;
  today?: Date;
  retryBaseDelayMs?: number;
};

export type GoogleAdsSyncResult = {
  ok: boolean;
  /** True when another live worker already owns overlapping units. */
  alreadyRunning: boolean;
  connected: boolean;
  projectId: string;
  customerId: string | null;
  mode: GoogleAdsSyncMode | null;
  window: { startDate: string; endDate: string; syncType: string } | null;
  run: GoogleAdsSyncRunPublic | null;
  unitsPlanned: number;
  unitsSucceeded: number;
  unitsFailed: number;
  status: "success" | "partial" | "failed" | "running" | "none";
  errorClass: string | null;
  message: string | null;
};

const DISCONNECTED_RESULT: Omit<GoogleAdsSyncResult, "projectId"> = {
  ok: false,
  alreadyRunning: false,
  connected: false,
  customerId: null,
  mode: null,
  window: null,
  run: null,
  unitsPlanned: 0,
  unitsSucceeded: 0,
  unitsFailed: 0,
  status: "none",
  errorClass: "DISCONNECTED",
  message: "Google Ads is not connected for this project.",
};

function resultBase(
  projectId: string,
  connection: GoogleAdsConnection,
  mode: GoogleAdsSyncMode,
): GoogleAdsSyncResult {
  return {
    ok: false,
    alreadyRunning: false,
    connected: true,
    projectId,
    customerId: connection.customerId,
    mode,
    window: null,
    run: null,
    unitsPlanned: 0,
    unitsSucceeded: 0,
    unitsFailed: 0,
    status: "failed",
    errorClass: null,
    message: null,
  };
}

/** The date×grain unit cartesian for the run window, in fixed order. */
function expandUnits(window: {
  startDate: string;
  endDate: string;
}): GoogleAdsUnitPlan[] {
  const units: GoogleAdsUnitPlan[] = [];
  for (const date of eachGoogleAdsDay(window.startDate, window.endDate)) {
    for (const grain of GOOGLE_ADS_GRAINS) {
      units.push({ date, grain });
    }
  }
  return units;
}

function publicRun(run: {
  id: string;
  projectId: string;
  customerId: string;
  runKey: string;
  mode: string;
  windowStartDate: string;
  windowEndDate: string;
  scheduledSlot: string | null;
  attempt: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  unitsTotal: number;
  unitsSucceeded: number;
  unitsFailed: number;
  errorClass: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}): GoogleAdsSyncRunPublic {
  return {
    id: run.id,
    projectId: run.projectId,
    customerId: run.customerId,
    runKey: run.runKey,
    mode: run.mode,
    windowStartDate: run.windowStartDate,
    windowEndDate: run.windowEndDate,
    scheduledSlot: run.scheduledSlot,
    attempt: run.attempt,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    unitsTotal: run.unitsTotal,
    unitsSucceeded: run.unitsSucceeded,
    unitsFailed: run.unitsFailed,
    errorClass: run.errorClass,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export async function runSync(
  options: GoogleAdsSyncServiceOptions,
): Promise<GoogleAdsSyncResult> {
  const { projectId, organizationId } = options;
  const mode: GoogleAdsSyncMode = options.mode ?? "manual";
  const retryBaseDelayMs =
    options.retryBaseDelayMs ?? GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS;

  const connection = await GoogleAdsConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  // A disconnected project is never an error and never a Google call: the
  // caller gets a clean false/none envelope instead of a stack trace.
  if (!connection) {
    return { ...DISCONNECTED_RESULT, projectId };
  }

  const scope = {
    projectId,
    organizationId,
    customerId: connection.customerId,
  };
  const fence = {
    connectionId: connection.id,
    grantAccountId: connection.grantAccountId,
    connectionUpdatedAt: connection.updatedAt,
  };
  const fingerprint = {
    connectionId: connection.id,
    grantAccountId: connection.grantAccountId,
    loginCustomerId: connection.loginCustomerId,
    connectionUpdatedAt: connection.updatedAt,
  };

  // Window resolution: explicit windows are clamped into the 37-month and
  // calendar bounds; otherwise the window slides from the last fully
  // covered date (initial backfill, incremental catch-up or the 3-day
  // conversion-lag refresh — same shape as the GA4 sync, per grain).
  const todayUtc = googleAdsSyncToday(options.today);
  let window: { startDate: string; endDate: string };
  let syncType: "initial" | "incremental" | "refresh" | "manual";
  if (options.startDate !== undefined || options.endDate !== undefined) {
    if (options.startDate === undefined || options.endDate === undefined) {
      // One-sided window hints are rejected BEFORE any claim, so a
      // validation error can never leave a running claim behind.
      return {
        ...resultBase(projectId, connection, mode),
        errorClass: "INVALID_WINDOW",
        message:
          "A custom Google Ads sync window requires start and end dates together.",
      };
    }
    const clamped = clampGoogleAdsSyncWindow(
      options.startDate,
      options.endDate,
      todayUtc,
    );
    if (!clamped) {
      return {
        ...resultBase(projectId, connection, mode),
        errorClass: "INVALID_WINDOW",
        message:
          "The Google Ads sync window dates are not valid calendar dates.",
      };
    }
    if (mode === "scheduled") {
      // Scheduled runs never take explicit windows: the cron trigger passes
      // no dates, so an explicit window there is a caller mistake.
      return {
        ...resultBase(projectId, connection, mode),
        errorClass: "INVALID_WINDOW",
        message: "Scheduled Google Ads syncs do not take an explicit window.",
      };
    }
    window = clamped;
    syncType = mode === "backfill" ? "manual" : mode;
  } else if (mode === "backfill") {
    return {
      ...resultBase(projectId, connection, mode),
      errorClass: "INVALID_WINDOW",
      message: "A Google Ads backfill requires an explicit start and end date.",
    };
  } else {
    // Coverage history is scanned from the current calendar year only: an
    // initial backfill (28 days) and incremental catch-up never need older
    // units than that once the cycle is warm.
    const priorUnits = await GoogleAdsAnalyticsRepository.listUnits(scope, {
      startDate: `${todayUtc.slice(0, 4)}-01-01`,
    });
    const decision = resolveGoogleAdsSyncWindow(
      googleAdsLastFullyCoveredDate(priorUnits),
      todayUtc,
    );
    window = { startDate: decision.startDate, endDate: decision.endDate };
    syncType = decision.syncType;
  }
  const windowPublic = { ...window, syncType };

  const claim = await GoogleAdsSyncRepository.claimRun({
    scope,
    mode,
    window,
    scheduledSlot: mode === "scheduled" ? new Date().toISOString() : null,
    fingerprint,
    leaseSeconds: GOOGLE_ADS_SYNC_LEASE_SECONDS,
  });
  if (claim.outcome !== "created" && claim.outcome !== "resumed") {
    if (claim.outcome === "coalesced") {
      // Another live worker owns these units right now: return the active
      // run and NEVER issue duplicate paid Google API calls. This is NOT an
      // error — it is the coalescing contract doing its job.
      return {
        ...resultBase(projectId, connection, mode),
        window: windowPublic,
        run: publicRun(claim.run),
        alreadyRunning: true,
        status: "running",
        errorClass: null,
        message: "A Google Ads run is already active for this account.",
      };
    }
    return {
      ...resultBase(projectId, connection, mode),
      window: windowPublic,
      errorClass: "CONNECTION_CHANGED",
      message:
        "The Google Ads connection changed or was disconnected before the sync started.",
      run: claim.run ? publicRun(claim.run) : null,
      status: claim.run ? "failed" : "none",
    };
  }
  const run = publicRun(claim.run);
  const runId = claim.run.id;
  const attempt = claim.run.attempt;

  const planned = await GoogleAdsSyncRepository.planUnits(
    runId,
    attempt,
    expandUnits(window),
  );
  if (planned.outcome === "stale") {
    return {
      ...resultBase(projectId, connection, mode),
      window: windowPublic,
      run,
      errorClass: "CONNECTION_CHANGED",
      message:
        "The sync run was fenced before it could plan its work; pending units stay untouched.",
    };
  }
  // planUnits returns exactly the pending work: committed success_* units
  // are never re-planned, so replay is bookmark-free and quota-cheap.
  const pendingUnits = planned.pendingUnits;

  const client = (options.createClient ?? createGoogleAdsClient)({
    userId: connection.connectedByUserId,
    grantAccountId: connection.grantAccountId,
  });

  const units = await runPendingUnits({
    runId,
    attempt,
    pendingUnits,
    client,
    connection,
    scope,
    fence,
    retryBaseDelayMs,
  });
  const { succeeded, failed, firstFailure, fatalCause } = units;

  const runPublic =
    (await GoogleAdsSyncRepository.getRunHistory(scope, { limit: 5 })).find(
      (entry) => entry.id === run.id,
    ) ?? run;

  if (fatalCause) {
    await GoogleAdsSyncRepository.abandonRun(
      runId,
      attempt,
      fatalCause.runErrorClass,
      fatalCause.message,
    );
    return {
      ...resultBase(projectId, connection, mode),
      window: windowPublic,
      run: runPublic,
      unitsPlanned: pendingUnits.length,
      unitsSucceeded: succeeded,
      unitsFailed: failed,
      errorClass: fatalCause.errorClass,
      message: fatalCause.message,
    };
  }

  const finalize = await GoogleAdsSyncRepository.finalizeRun(runId, attempt);
  const status = finalize.outcome === "finalized" ? finalize.status : "failed";
  return {
    ...resultBase(projectId, connection, mode),
    ok: status === "success" || status === "partial",
    status,
    window: windowPublic,
    run: runPublic,
    unitsPlanned: pendingUnits.length,
    unitsSucceeded: succeeded,
    unitsFailed: failed,
    errorClass:
      status === "success"
        ? null
        : (firstFailure?.errorClass ?? "unknown_error"),
    message: status === "success" ? null : (firstFailure?.message ?? null),
  };
}

export const GoogleAdsSyncService = {
  runSync,
};
