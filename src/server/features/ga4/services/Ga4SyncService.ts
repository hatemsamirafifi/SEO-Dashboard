/* eslint-disable max-lines */
import { Ga4ConnectionRepository } from "../repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";
import {
  createGa4Client,
  classifyGa4Error,
  Ga4ApiError,
  Ga4NotConnectedError,
} from "@/server/lib/ga4Client";
import {
  splitDateRangeIntoChunks,
  addDaysUtc,
  type DateChunk,
} from "@/server/features/gsc/services/gscSyncUtils";
import {
  GA4_GRAINS,
  GA4_SYNC_CHUNK_DAYS,
  GA4_INITIAL_WINDOW_DAYS,
  GA4_LANDING_PAGE_TOP_N,
  GA4_REPORT_PAGE_LIMIT,
  GA4_STALE_RUN_MS,
  buildGeoTechSubRequests,
  buildGrainSubRequests,
  eachDayUtc,
  isFatalGa4ErrorClass,
  isSuccessCoverageStatus,
  type Ga4CoverageStatus,
  type Ga4SyncGrain,
} from "./ga4SyncUtils";
import {
  QuotaHaltError,
  fetchGrainPages,
  normalizeChunkResponses,
} from "./ga4SyncNormalize";

export type Ga4SyncOptions = {
  projectId: string;
  organizationId: string;
  syncType?: "initial" | "incremental" | "manual";
  startDate?: string;
  endDate?: string;
  chunkDays?: number;
};

export type Ga4SyncResult = {
  ok: boolean;
  alreadyRunning?: boolean;
  syncId: string;
  projectId: string;
  propertyId: string;
  syncType: string;
  startDate: string;
  endDate: string;
  chunksTotal: number;
  chunksCompleted: number;
  rowsFetched: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsFailed: number;
  successfulUnits: number;
  durationMs: number;
  error?: string;
  errorClass?: string;
  status: "completed" | "partial" | "failed" | "running";
  lastSuccessfulDate?: string | null;
};

type CoverageMap = Map<string, Map<Ga4SyncGrain, Ga4CoverageStatus>>;
type Ga4Client = ReturnType<typeof createGa4Client>;

const RECONNECT_GUIDANCE =
  "Reconnect Google Analytics in project Settings and try again.";

type SyncConnection = {
  id: string;
  propertyId: string;
  connectedByUserId: string;
  ga4AccountId: string;
  currencyCode: string | null;
  hasEcommerce: boolean;
};

async function resolveSyncWindow(
  options: Ga4SyncOptions,
  connection: SyncConnection,
  client: Ga4Client,
  today: Date = new Date(),
): Promise<{
  startDate: string;
  endDate: string;
  syncType: "initial" | "incremental" | "manual";
}> {
  const todayUtc = today.toISOString().slice(0, 10);
  if (options.startDate && options.endDate) {
    const clampedEnd = options.endDate > todayUtc ? todayUtc : options.endDate;
    const clampedStart =
      options.startDate > clampedEnd ? clampedEnd : options.startDate;
    return {
      startDate: clampedStart,
      endDate: clampedEnd,
      syncType: options.syncType ?? "manual",
    };
  }
  const requestedType = options.syncType ?? "manual";
  if (requestedType !== "initial") {
    const lastCovered = await Ga4SyncRepository.getLastFullyCoveredDate(
      options.projectId,
      connection.propertyId,
      [...GA4_GRAINS],
      todayUtc,
    );
    if (lastCovered) {
      const next = addDaysUtc(lastCovered, 1);
      return {
        startDate: next > todayUtc ? lastCovered : next,
        endDate: todayUtc,
        syncType: requestedType,
      };
    }
  }
  // Initial (or first-ever) sync: min(90d, property creation). Admin failure
  // propagates — a silent 90d fallback could write pre-creation fake zeros.
  const creation = await client.getPropertyCreateTime(connection.propertyId);
  const floor = addDaysUtc(todayUtc, -GA4_INITIAL_WINDOW_DAYS);
  let startDate = floor;
  if (creation && creation > startDate && creation <= todayUtc) {
    startDate = creation;
  }
  return { startDate, endDate: todayUtc, syncType: "initial" };
}

function alreadyRunningResult(
  options: Ga4SyncOptions,
  propertyId: string,
  chunksTotal: number,
  active: {
    id: string;
    syncType: string;
    requestedStartDate: string;
    requestedEndDate: string;
    rowsFetched: number;
    rowsInserted: number;
    rowsUpdated: number;
    rowsFailed: number;
    successfulUnits: number;
  },
): Ga4SyncResult {
  return {
    ok: false,
    alreadyRunning: true,
    syncId: active.id,
    projectId: options.projectId,
    propertyId,
    syncType: active.syncType,
    startDate: active.requestedStartDate,
    endDate: active.requestedEndDate,
    chunksTotal,
    chunksCompleted: 0,
    rowsFetched: active.rowsFetched,
    rowsInserted: active.rowsInserted,
    rowsUpdated: active.rowsUpdated,
    rowsFailed: active.rowsFailed,
    successfulUnits: active.successfulUnits,
    durationMs: 0,
    status: "running",
  };
}

type ChunkOutcome = {
  fetched: number;
  failed: number;
  inserted: number;
  successful: number;
  observedRevenue: boolean;
  observedCurrency: string | null;
  grainError: { errorClass: string; message: string } | null;
};

/** Fetch, normalize, and persist one chunk: one batch call covering the five
 *  core grains, offset pagination for full pages, two individual runReport
 *  calls for the bounded geo/technology grains (the Data API caps a batch
 *  at five sub-requests), then ordered metric-then-coverage writes. Throws
 *  on quota, provider, and write failures (caller decides unit marking from
 *  the error class). */
async function processChunk(input: {
  client: Ga4Client;
  connection: SyncConnection;
  projectId: string;
  chunk: DateChunk;
  coverage: CoverageMap;
}): Promise<ChunkOutcome> {
  const { client, connection, projectId, chunk, coverage } = input;
  const subRequests = buildGrainSubRequests({
    propertyId: connection.propertyId,
    startDate: chunk.startDate,
    endDate: chunk.endDate,
  });
  const responses = await client.batchRunReports(subRequests);
  if (responses.length !== subRequests.length) {
    throw new Error("GA4 batch response count mismatch");
  }
  const limits = [
    GA4_REPORT_PAGE_LIMIT,
    GA4_REPORT_PAGE_LIMIT,
    GA4_REPORT_PAGE_LIMIT,
    GA4_LANDING_PAGE_TOP_N,
    GA4_REPORT_PAGE_LIMIT,
  ];
  const paged = [];
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    if (response instanceof Ga4ApiError || index === 3) {
      paged.push(response);
      continue;
    }
    const { pages } = await fetchGrainPages(
      client,
      subRequests[index],
      response,
      true,
    );
    paged.push(
      pages.length === 1
        ? pages[0]
        : {
            rowCount: pages[0].rowCount,
            rows: pages.flatMap((page) => page.rows),
            metadata: pages[0].metadata,
          },
    );
  }
  // Bounded grains ride outside the batch (5-request API cap). Thrown quota
  // / provider errors propagate to the run loop: quota leaves the chunk
  // PENDING, other classes fail its pending units — nothing is half-written
  // because upserts happen after all fetches complete.
  const [geoSubRequest, techSubRequest] = buildGeoTechSubRequests({
    propertyId: connection.propertyId,
    startDate: chunk.startDate,
    endDate: chunk.endDate,
  });
  const tailCountsKnown: { geo: boolean; technology: boolean } = {
    geo: false,
    technology: false,
  };
  for (const [slot, subRequest] of [
    ["geo", geoSubRequest],
    ["technology", techSubRequest],
  ] as const) {
    const first = await client.runReport(subRequest);
    const { pages, truncated } = await fetchGrainPages(
      client,
      subRequest,
      first,
      true,
    );
    tailCountsKnown[slot] = !truncated;
    paged.push(
      pages.length === 1
        ? pages[0]
        : {
            rowCount: pages[0].rowCount,
            rows: pages.flatMap((page) => page.rows),
            metadata: pages[0].metadata,
          },
    );
  }
  const normalized = await normalizeChunkResponses({
    projectId,
    propertyId: connection.propertyId,
    connectionId: connection.id,
    chunk,
    responses: paged,
    limits: [...limits, GA4_REPORT_PAGE_LIMIT, GA4_REPORT_PAGE_LIMIT],
    tailCountsKnown,
  });
  const inserted =
    normalized.summaryRows.length +
    normalized.acquisitionRows.length +
    normalized.landingRows.length +
    normalized.eventRows.length +
    normalized.geoRows.length +
    normalized.technologyRows.length;
  if (inserted > 0) {
    await Ga4SyncRepository.upsertSummaryRows(normalized.summaryRows);
    await Ga4SyncRepository.upsertAcquisitionRows(normalized.acquisitionRows);
    await Ga4SyncRepository.upsertLandingRows(normalized.landingRows);
    await Ga4SyncRepository.upsertEventRows(normalized.eventRows);
    await Ga4SyncRepository.upsertGeoRows(normalized.geoRows);
    await Ga4SyncRepository.upsertTechnologyRows(normalized.technologyRows);
  }
  await Ga4SyncRepository.markUnits(
    normalized.outcomes.map((outcome) => ({
      projectId,
      propertyId: connection.propertyId,
      date: outcome.date,
      grain: outcome.grain,
      status: outcome.status,
      truncationMeta: outcome.truncationMeta ?? null,
    })),
  );
  let successful = 0;
  for (const outcome of normalized.outcomes) {
    let day = coverage.get(outcome.date);
    if (!day) {
      day = new Map();
      coverage.set(outcome.date, day);
    }
    day.set(outcome.grain, outcome.status);
    if (
      outcome.status === "SUCCESS_WITH_DATA" ||
      outcome.status === "SUCCESS_ZERO_ROWS"
    ) {
      successful += 1;
    }
  }
  return {
    fetched: normalized.fetched,
    failed: normalized.failed,
    inserted,
    successful,
    observedRevenue: normalized.observedRevenue,
    observedCurrency: normalized.observedCurrency,
    grainError: normalized.firstError ?? null,
  };
}

/** Mark a halted chunk's attempted units FAILED (quota halts leave them
 *  PENDING instead and never reach this helper). */
async function failChunkUnits(input: {
  projectId: string;
  propertyId: string;
  chunkDates: string[];
  pendingGrains: Map<string, boolean>;
  coverage: CoverageMap;
}): Promise<void> {
  const failedUnits = [];
  for (const date of input.chunkDates) {
    for (const grain of GA4_GRAINS) {
      if (input.pendingGrains.get(`${date}|${grain}`)) {
        failedUnits.push({
          projectId: input.projectId,
          propertyId: input.propertyId,
          date,
          grain,
          status: "FAILED" as const,
          truncationMeta: null,
        });
      }
    }
  }
  if (failedUnits.length === 0) return;
  await Ga4SyncRepository.markUnits(failedUnits);
  for (const unit of failedUnits) {
    let day = input.coverage.get(unit.date);
    if (!day) {
      day = new Map();
      input.coverage.set(unit.date, day);
    }
    day.set(unit.grain, "FAILED");
  }
}

async function finalizeRun(input: {
  syncId: string;
  projectId: string;
  propertyId: string;
  syncType: string;
  startDate: string;
  endDate: string;
  dates: string[];
  coverage: CoverageMap;
  chunksTotal: number;
  chunksCompleted: number;
  chunksAttempted: number;
  rowsFetched: number;
  rowsInserted: number;
  rowsFailed: number;
  successfulUnits: number;
  startTime: number;
  errorInfo: { errorClass: string; message: string } | null;
  fatal: boolean;
  connection: SyncConnection;
  observedRevenue: boolean;
  observedCurrency: string | null;
}): Promise<Ga4SyncResult> {
  if (
    input.observedRevenue ||
    (input.observedCurrency && !input.connection.currencyCode)
  ) {
    await Ga4ConnectionRepository.updateConnectionCapabilities(
      input.connection.id,
      {
        ...(input.observedRevenue ? { hasEcommerce: true } : {}),
        ...(input.observedCurrency && !input.connection.currencyCode
          ? { currencyCode: input.observedCurrency }
          : {}),
      },
    );
  }

  let lastCovered: string | null = null;
  for (const date of input.dates) {
    const day = input.coverage.get(date);
    const allSuccess = GA4_GRAINS.every((grain) =>
      isSuccessCoverageStatus(day?.get(grain) ?? ""),
    );
    if (allSuccess) lastCovered = date;
    else break;
  }

  let status: "completed" | "partial" | "failed";
  let ok: boolean;
  // Zero new units with no work attempted means an idempotent no-op re-run
  // over fully-covered dates — that completes. Zero units after attempted
  // work means nothing finalized: failed.
  if (
    input.fatal ||
    (input.successfulUnits === 0 && input.chunksAttempted > 0)
  ) {
    status = "failed";
    ok = false;
  } else if (input.errorInfo) {
    status = "partial";
    ok = false;
  } else if (lastCovered !== null && lastCovered >= input.endDate) {
    status = "completed";
    ok = true;
  } else {
    status = "partial";
    ok = true;
  }

  await Ga4SyncRepository.updateSyncRun(input.syncId, {
    status,
    completedAt: new Date().toISOString(),
    rowsFetched: input.rowsFetched,
    rowsInserted: input.rowsInserted,
    rowsFailed: input.rowsFailed,
    successfulUnits: input.successfulUnits,
    error: input.errorInfo
      ? `${input.errorInfo.errorClass}: ${input.errorInfo.message}`
      : null,
    errorClass: input.errorInfo?.errorClass ?? null,
  });

  return {
    ok,
    syncId: input.syncId,
    projectId: input.projectId,
    propertyId: input.propertyId,
    syncType: input.syncType,
    startDate: input.startDate,
    endDate: input.endDate,
    chunksTotal: input.chunksTotal,
    chunksCompleted: input.chunksCompleted,
    rowsFetched: input.rowsFetched,
    rowsInserted: input.rowsInserted,
    rowsUpdated: 0,
    rowsFailed: input.rowsFailed,
    successfulUnits: input.successfulUnits,
    durationMs: Date.now() - input.startTime,
    error: input.errorInfo?.message,
    errorClass: input.errorInfo?.errorClass,
    status,
    lastSuccessfulDate: lastCovered,
  };
}

async function runSync(options: Ga4SyncOptions): Promise<Ga4SyncResult> {
  const startTime = Date.now();
  const connection = await Ga4ConnectionRepository.getByProjectId(
    options.projectId,
    options.organizationId,
  );
  if (!connection) {
    throw new Ga4NotConnectedError(options.projectId);
  }
  const { propertyId } = connection;

  await Ga4SyncRepository.markStaleRunsFailed(
    options.projectId,
    propertyId,
    new Date(Date.now() - GA4_STALE_RUN_MS).toISOString(),
  );

  const client = createGa4Client({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
  });

  const { startDate, endDate, syncType } = await resolveSyncWindow(
    options,
    connection,
    client,
  );
  const chunkDays = options.chunkDays ?? GA4_SYNC_CHUNK_DAYS;
  const chunks = splitDateRangeIntoChunks(startDate, endDate, chunkDays);

  const existingRun = await Ga4SyncRepository.getActiveSyncRun(
    options.projectId,
    propertyId,
  );
  if (existingRun) {
    return alreadyRunningResult(
      options,
      propertyId,
      chunks.length,
      existingRun,
    );
  }

  const createResult = await Ga4SyncRepository.createSyncRun({
    projectId: options.projectId,
    ga4ConnectionId: connection.id,
    propertyId,
    syncType,
    requestedStartDate: startDate,
    requestedEndDate: endDate,
  });
  if (!createResult.ok) {
    return alreadyRunningResult(
      options,
      propertyId,
      chunks.length,
      createResult.sync,
    );
  }
  const sync = createResult.sync;

  const dates = eachDayUtc(startDate, endDate);
  const force = Boolean(options.startDate && options.endDate);
  await Ga4SyncRepository.seedPendingUnits({
    projectId: options.projectId,
    propertyId,
    dates,
    grains: [...GA4_GRAINS],
    force,
  });
  const coverage = await Ga4SyncRepository.getCoverageMap(
    options.projectId,
    propertyId,
    startDate,
    endDate,
  );

  let rowsFetched = 0;
  let rowsInserted = 0;
  let rowsFailed = 0;
  let chunksCompleted = 0;
  let chunksAttempted = 0;
  let successfulUnits = 0;
  let observedRevenue = false;
  let observedCurrency: string | null = null;
  let errorInfo: { errorClass: string; message: string } | null = null;
  let fatal = false;

  for (const chunk of chunks) {
    const chunkDates = eachDayUtc(chunk.startDate, chunk.endDate);
    const pendingGrains = new Map<string, boolean>();
    let chunkHasWork = false;
    for (const date of chunkDates) {
      for (const grain of GA4_GRAINS) {
        const status = coverage.get(date)?.get(grain);
        if (!isSuccessCoverageStatus(status ?? "")) {
          chunkHasWork = true;
          pendingGrains.set(`${date}|${grain}`, true);
        }
      }
    }
    if (!chunkHasWork) continue;
    chunksAttempted += 1;

    try {
      const outcome = await processChunk({
        client,
        connection,
        projectId: options.projectId,
        chunk,
        coverage,
      });
      rowsFetched += outcome.fetched;
      rowsFailed += outcome.failed;
      rowsInserted += outcome.inserted;
      successfulUnits += outcome.successful;
      if (outcome.observedRevenue) observedRevenue = true;
      if (observedCurrency === null && outcome.observedCurrency) {
        observedCurrency = outcome.observedCurrency;
      }
      if (outcome.grainError && !errorInfo) {
        errorInfo = outcome.grainError;
        fatal = isFatalGa4ErrorClass(outcome.grainError.errorClass);
      }
      chunksCompleted += 1;
      await Ga4SyncRepository.updateSyncRun(sync.id, {
        rowsFetched,
        rowsInserted,
        rowsFailed,
        successfulUnits,
        checkpoint: JSON.stringify({ lastCompletedChunk: chunk.endDate }),
      });
    } catch (err) {
      if (err instanceof QuotaHaltError) {
        errorInfo = {
          errorClass: "QUOTA_EXHAUSTED",
          message:
            "Google Analytics Data API quota exhausted. Retry after the quota window.",
        };
        break;
      }
      const classification = classifyGa4Error(err);
      if (classification.errorClass === "QUOTA_EXHAUSTED") {
        errorInfo = {
          errorClass: classification.errorClass,
          message: classification.message,
        };
        break;
      }
      await failChunkUnits({
        projectId: options.projectId,
        propertyId,
        chunkDates,
        pendingGrains,
        coverage,
      });
      let message = classification.message;
      if (
        classification.errorClass === "OAUTH_TOKEN_FAILURE" ||
        classification.errorClass === "PERMISSION_DENIED"
      ) {
        message = `${message} ${RECONNECT_GUIDANCE}`;
      }
      errorInfo = { errorClass: classification.errorClass, message };
      fatal = fatal || isFatalGa4ErrorClass(classification.errorClass);
      break;
    }
  }

  return finalizeRun({
    syncId: sync.id,
    projectId: options.projectId,
    propertyId,
    syncType,
    startDate,
    endDate,
    dates,
    coverage,
    chunksTotal: chunks.length,
    chunksCompleted,
    chunksAttempted,
    rowsFetched,
    rowsInserted,
    rowsFailed,
    successfulUnits,
    startTime,
    errorInfo,
    fatal,
    connection,
    observedRevenue,
    observedCurrency,
  });
}

export const Ga4SyncService = {
  runSync,
};
