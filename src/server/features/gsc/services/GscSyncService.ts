import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import {
  deterministicGscFactId,
  GscSearchPerformanceRepository,
  type GscSearchPerformanceInsert,
} from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  createGscClient,
  type GscSearchAnalyticsRequest,
  type GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import { GscNotConnectedError } from "@/server/features/gsc/services/GscService";
import { sixteenMonthFloor } from "@/server/features/gsc/searchAnalytics";
import {
  type DateChunk,
  type GscSyncGrain,
  GSC_GRAIN_CONFIGS,
  splitDateRangeIntoChunks,
  classifyGscSyncError,
} from "@/server/features/gsc/services/gscSyncUtils";

export type { DateChunk, GscSyncGrain };
export { GSC_GRAIN_CONFIGS, splitDateRangeIntoChunks, classifyGscSyncError };

export interface NormalizeGscRowOptions {
  gscConnectionId?: string | null;
  searchType?: string;
}

export async function normalizeGscRow(
  row: GscSearchAnalyticsRow,
  grain: GscSyncGrain,
  projectId: string,
  property: string,
  options?: NormalizeGscRowOptions,
): Promise<GscSearchPerformanceInsert | null> {
  const date = row.keys?.[0];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const gscConnectionId = options?.gscConnectionId ?? null;
  const searchType = options?.searchType ?? "web";

  let grainKey = "";
  let query: string | null = null;
  let page: string | null = null;
  let country: string | null = null;
  let device: string | null = null;
  let searchAppearance: string | null = null;

  switch (grain) {
    case "summary":
      grainKey = "";
      break;
    case "query":
      query = row.keys?.[1] ?? "";
      grainKey = query;
      break;
    case "page":
      page = row.keys?.[1] ?? "";
      grainKey = page;
      break;
    case "query_page":
      query = row.keys?.[1] ?? "";
      page = row.keys?.[2] ?? "";
      grainKey = `${query}::${page}`;
      break;
    case "country":
      country = (row.keys?.[1] ?? "").toLowerCase();
      grainKey = country;
      break;
    case "device":
      device = (row.keys?.[1] ?? "").toUpperCase();
      grainKey = device;
      break;
    case "search_appearance":
      searchAppearance = row.keys?.[1] ?? "";
      grainKey = searchAppearance;
      break;
  }

  const id = await deterministicGscFactId({
    projectId,
    property,
    searchType,
    date,
    grain,
    grainKey,
  });

  return {
    id,
    projectId,
    gscConnectionId,
    property,
    date,
    grain,
    grainKey,
    query,
    page,
    country,
    device,
    searchAppearance,
    searchType,
    clicks: Math.max(0, Math.round(row.clicks ?? 0)),
    impressions: Math.max(0, Math.round(row.impressions ?? 0)),
    ctr: typeof row.ctr === "number" ? Math.max(0, row.ctr) : 0,
    position: typeof row.position === "number" ? Math.max(0, row.position) : 0,
  };
}

export type GscSyncOptions = {
  projectId: string;
  syncType?: "initial_backfill" | "incremental" | "manual";
  startDate?: string;
  endDate?: string;
  chunkDays?: number;
  searchType?: string;
  resume?: boolean;
};

export type GscSyncResult = {
  ok: boolean;
  alreadyRunning?: boolean;
  syncId: string;
  projectId: string;
  property: string;
  syncType: string;
  startDate: string;
  endDate: string;
  chunksTotal: number;
  chunksCompleted: number;
  rowsFetched: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsFailed: number;
  durationMs: number;
  error?: string;
  errorClass?: string;
  status: "completed" | "partial" | "failed" | "running";
};

const GSC_DATA_LAG_DAYS = 3;
const DEFAULT_CHUNK_DAYS = 7;
const GSC_SYNC_FETCH_LIMIT = 5000;

function resolveSyncWindow(
  options: GscSyncOptions,
  today: Date = new Date(),
): { startDate: string; endDate: string; syncType: "initial_backfill" | "incremental" | "manual" } {
  const syncType = options.syncType ?? "manual";

  if (options.startDate && options.endDate) {
    return {
      startDate: options.startDate,
      endDate: options.endDate,
      syncType,
    };
  }

  const lagDate = new Date(today.getTime() - GSC_DATA_LAG_DAYS * 24 * 60 * 60 * 1000);
  const endDate = lagDate.toISOString().slice(0, 10);

  if (syncType === "initial_backfill") {
    const floor = sixteenMonthFloor(today);
    return { startDate: floor, endDate, syncType };
  }

  const defaultStartMs = lagDate.getTime() - 7 * 24 * 60 * 60 * 1000;
  const startDate = new Date(defaultStartMs).toISOString().slice(0, 10);
  return { startDate, endDate, syncType };
}

async function syncGrainForChunk(params: {
  client: ReturnType<typeof createGscClient>;
  connection: { siteUrl: string; id?: string | null };
  grainConfig: (typeof GSC_GRAIN_CONFIGS)[number];
  chunk: DateChunk;
  projectId: string;
  searchType: string;
}): Promise<{ facts: GscSearchPerformanceInsert[]; fetched: number; failed: number }> {
  const { client, connection, grainConfig, chunk, projectId, searchType } = params;
  const facts: GscSearchPerformanceInsert[] = [];
  let fetched = 0;
  let failed = 0;
  let startRow = 0;
  let hasMore = true;

  while (hasMore) {
    const request: GscSearchAnalyticsRequest = {
      startDate: chunk.startDate,
      endDate: chunk.endDate,
      dimensions: grainConfig.dimensions,
      type: searchType,
      rowLimit: GSC_SYNC_FETCH_LIMIT,
      dataState: "all",
      ...(startRow > 0 ? { startRow } : {}),
    };

    const rawRows = await client.querySearchAnalytics(connection.siteUrl, request);
    fetched += rawRows.length;

    for (const rawRow of rawRows) {
      const fact = await normalizeGscRow(
        rawRow,
        grainConfig.grain,
        projectId,
        connection.siteUrl,
        { gscConnectionId: connection.id, searchType },
      );
      if (fact) {
        facts.push(fact);
      } else {
        failed++;
      }
    }

    if (rawRows.length < GSC_SYNC_FETCH_LIMIT || startRow >= 25000) {
      hasMore = false;
    } else {
      startRow += GSC_SYNC_FETCH_LIMIT;
    }
  }

  return { facts, fetched, failed };
}

async function runSync(options: GscSyncOptions): Promise<GscSyncResult> {
  const startTime = Date.now();
  const connection = await GscConnectionRepository.getByProjectId(options.projectId);
  if (!connection || !connection.siteUrl) {
    throw new GscNotConnectedError(options.projectId);
  }

  const { startDate, endDate, syncType } = resolveSyncWindow(options);
  const searchType = options.searchType ?? "web";
  const chunkDays = options.chunkDays ?? DEFAULT_CHUNK_DAYS;
  let chunks = splitDateRangeIntoChunks(startDate, endDate, chunkDays);

  const existingRun = await GscSearchPerformanceRepository.getActiveSyncRun(
    options.projectId,
    connection.siteUrl,
  );

  if (existingRun) {
    return {
      ok: false,
      alreadyRunning: true,
      syncId: existingRun.id,
      projectId: options.projectId,
      property: connection.siteUrl,
      syncType: existingRun.syncType,
      startDate: existingRun.requestedStartDate,
      endDate: existingRun.requestedEndDate,
      chunksTotal: chunks.length,
      chunksCompleted: 0,
      rowsFetched: existingRun.rowsFetched,
      rowsInserted: existingRun.rowsInserted,
      rowsUpdated: existingRun.rowsUpdated,
      rowsFailed: existingRun.rowsFailed,
      durationMs: 0,
      status: "running",
    };
  }

  const createResult = await GscSearchPerformanceRepository.createSyncRun({
    projectId: options.projectId,
    gscConnectionId: connection.id,
    property: connection.siteUrl,
    syncType,
    requestedStartDate: startDate,
    requestedEndDate: endDate,
  });

  if (!createResult.ok) {
    const active = createResult.sync;
    return {
      ok: false,
      alreadyRunning: true,
      syncId: active.id,
      projectId: options.projectId,
      property: connection.siteUrl,
      syncType: active.syncType,
      startDate: active.requestedStartDate,
      endDate: active.requestedEndDate,
      chunksTotal: chunks.length,
      chunksCompleted: 0,
      rowsFetched: active.rowsFetched,
      rowsInserted: active.rowsInserted,
      rowsUpdated: active.rowsUpdated,
      rowsFailed: active.rowsFailed,
      durationMs: 0,
      status: "running",
    };
  }

  const sync = createResult.sync;

  const client = createGscClient({
    userId: connection.connectedByUserId,
    gscAccountId: connection.gscAccountId ?? undefined,
  });

  if (options.resume && sync.checkpoint) {
    try {
      const parsed: unknown = JSON.parse(sync.checkpoint);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "lastCompletedDate" in parsed
      ) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.lastCompletedDate === "string") {
          const lastDate = record.lastCompletedDate;
          chunks = chunks.filter((c) => c.startDate > lastDate);
        }
      }
    } catch {
      // If checkpoint parse fails, process all chunks
    }
  }

  let rowsFetched = 0;
  let rowsInserted = 0;
  let rowsFailed = 0;
  let chunksCompleted = 0;
  let lastSuccessfulDate: string | null = sync.actualLastSuccessfulDate;

  try {
    for (const chunk of chunks) {
      const chunkFacts: GscSearchPerformanceInsert[] = [];

      for (const grainConfig of GSC_GRAIN_CONFIGS) {
        const res = await syncGrainForChunk({
          client,
          connection,
          grainConfig,
          chunk,
          projectId: options.projectId,
          searchType,
        });
        chunkFacts.push(...res.facts);
        rowsFetched += res.fetched;
        rowsFailed += res.failed;
      }

      if (chunkFacts.length > 0) {
        const result = await GscSearchPerformanceRepository.upsertFacts(chunkFacts);
        rowsInserted += result.inserted;
      }

      lastSuccessfulDate = chunk.endDate;
      chunksCompleted++;

      await GscSearchPerformanceRepository.updateSyncRun(sync.id, {
        actualLastSuccessfulDate: lastSuccessfulDate,
        rowsFetched,
        rowsInserted,
        rowsFailed,
        checkpoint: JSON.stringify({ lastCompletedDate: chunk.endDate }),
      });
    }

    await GscSearchPerformanceRepository.updateSyncRun(sync.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      rowsFetched,
      rowsInserted,
      rowsFailed,
    });

    return {
      ok: true,
      syncId: sync.id,
      projectId: options.projectId,
      property: connection.siteUrl,
      syncType,
      startDate,
      endDate,
      chunksTotal: chunks.length,
      chunksCompleted,
      rowsFetched,
      rowsInserted,
      rowsUpdated: 0,
      rowsFailed,
      durationMs: Date.now() - startTime,
      status: "completed",
    };
  } catch (err) {
    const classified = classifyGscSyncError(err);
    const finalStatus = chunksCompleted > 0 ? "partial" : "failed";

    await GscSearchPerformanceRepository.updateSyncRun(sync.id, {
      status: finalStatus,
      completedAt: new Date().toISOString(),
      rowsFetched,
      rowsInserted,
      rowsFailed,
      error: `${classified.errorClass}: ${classified.message}`,
    });

    return {
      ok: false,
      syncId: sync.id,
      projectId: options.projectId,
      property: connection.siteUrl,
      syncType,
      startDate,
      endDate,
      chunksTotal: chunks.length,
      chunksCompleted,
      rowsFetched,
      rowsInserted,
      rowsUpdated: 0,
      rowsFailed,
      durationMs: Date.now() - startTime,
      error: classified.message,
      errorClass: classified.errorClass,
      status: finalStatus,
    };
  }
}

export const GscSyncService = {
  runSync,
  splitDateRangeIntoChunks,
  normalizeGscRow,
  classifyGscSyncError,
};
