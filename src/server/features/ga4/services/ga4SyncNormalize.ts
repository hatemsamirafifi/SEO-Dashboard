/* eslint-disable max-lines */
import type { createGa4Client } from "@/server/lib/ga4Client";
import { classifyGa4Error, Ga4ApiError } from "@/server/lib/ga4Client";
import type { Ga4ReportResult } from "@/server/lib/ga4Client";
import {
  GA4_OTHER_DIMENSION,
  canonicalGa4Dimension,
  normalizeGa4LandingPage,
} from "@/shared/ga4";
import {
  deterministicGa4FactId,
  type Ga4AcquisitionInsert,
  type Ga4EventInsert,
  type Ga4GeoInsert,
  type Ga4LandingInsert,
  type Ga4SummaryInsert,
  type Ga4TechnologyInsert,
} from "../repositories/Ga4SyncRepository";
import type { DateChunk } from "@/server/features/gsc/services/gscSyncUtils";
import {
  GA4_BATCH_SUB_REQUEST_COUNT,
  GA4_GEO_TECH_SUB_REQUEST_COUNT,
  GA4_GEO_TOP_N,
  GA4_REPORT_MAX_PAGES,
  GA4_TECHNOLOGY_TOP_N,
  eachDayUtc,
  rollUpOtherTail,
  type Ga4CoverageStatus,
  type Ga4GrainSubRequest,
  type Ga4SyncGrain,
  type Ga4TailMetrics,
  type Ga4TruncationMeta,
} from "./ga4SyncUtils";

export type UnitOutcome = {
  date: string;
  grain: Ga4SyncGrain;
  status: Ga4CoverageStatus;
  truncationMeta?: Ga4TruncationMeta | null;
};

export type ChunkNormalization = {
  summaryRows: Ga4SummaryInsert[];
  acquisitionRows: Ga4AcquisitionInsert[];
  landingRows: Ga4LandingInsert[];
  eventRows: Ga4EventInsert[];
  geoRows: Ga4GeoInsert[];
  technologyRows: Ga4TechnologyInsert[];
  outcomes: UnitOutcome[];
  fetched: number;
  failed: number;
  observedRevenue: boolean;
  observedCurrency: string | null;
  firstError?: { errorClass: string; message: string };
};

/** Total batch responses per chunk: the five batchRunReports sub-requests
 *  plus the two individually-fetched geo/technology reports. */
export const GA4_CHUNK_RESPONSE_COUNT =
  GA4_BATCH_SUB_REQUEST_COUNT + GA4_GEO_TECH_SUB_REQUEST_COUNT;

/** Quota aborts the run with the remainder PENDING (never FAILED). Thrown
 *  when a batch sub-request reports quota exhaustion. */
export class QuotaHaltError extends Error {}

export function toIsoDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function toIntNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function toFloatNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function parseInts(values: unknown, expected: number): number[] | null {
  if (!Array.isArray(values) || values.length < expected) return null;
  const out: number[] = [];
  for (const value of values.slice(0, expected)) {
    const parsed = toIntNumber(value);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}


export function truncationFor(
  response: Ga4ReportResult,
  limit: number,
): Ga4TruncationMeta | null {
  if ((response.rowCount ?? 0) <= response.rows.length) return null;
  return {
    row_limit: limit,
    rows_returned: response.rows.length,
    is_truncated: true,
    total_rows_if_known: response.rowCount ?? null,
    sampling_state: response.metadata.samplingState,
    data_loss_from_other_row: null,
  };
}

type GrainContext = {
  projectId: string;
  propertyId: string;
  connectionId: string | null;
  chunkDates: Set<string>;
};

type FailedDates = Map<string, Set<string>>;

function failDate(failed: FailedDates, grain: Ga4SyncGrain, date: string) {
  let set = failed.get(grain);
  if (!set) {
    set = new Set();
    failed.set(grain, set);
  }
  set.add(date);
}

async function normalizeSummaryResponses(
  core: Ga4ReportResult,
  revenue: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
): Promise<{ rows: Ga4SummaryInsert[]; observedRevenue: boolean }> {
  const rows: Ga4SummaryInsert[] = [];
  let observedRevenue = false;
  const revenueByDate = new Map<string, unknown[]>();
  for (const row of revenue.rows) {
    const date = toIsoDate(row.dimensionValues[0] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    revenueByDate.set(date, row.metricValues);
  }
  const coreByDate = new Map<string, unknown[]>();
  for (const row of core.rows) {
    const date = toIsoDate(row.dimensionValues[0] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    coreByDate.set(date, row.metricValues);
  }
  for (const date of coreByDate.keys()) {
    const coreMetrics = coreByDate.get(date);
    if (!coreMetrics) {
      failDate(failed, "summary", date);
      failRow();
      continue;
    }
    const coreInts = parseInts(coreMetrics, 8);
    const userEngagementDuration = toFloatNumber(coreMetrics[2]);
    const totalUsers = toIntNumber(coreMetrics[6] ?? "0");
    const activeUsers = toIntNumber(coreMetrics[7] ?? "0");
    if (
      !coreInts ||
      userEngagementDuration === null ||
      totalUsers === null ||
      activeUsers === null
    ) {
      failDate(failed, "summary", date);
      failRow();
      continue;
    }
    const [sessions, engagedSessions, , screenPageViews, eventCount, newUsers] =
      coreInts;
    const revMetrics = revenueByDate.get(date) ?? [];
    const totalRevenue = toFloatNumber(revMetrics[0]) ?? 0;
    const purchaseRevenue = toFloatNumber(revMetrics[1]) ?? 0;
    const transactions = toIntNumber(revMetrics[2]) ?? 0;
    const addToCarts = toIntNumber(revMetrics[3]) ?? 0;
    const checkouts = toIntNumber(revMetrics[4]) ?? 0;
    if (totalRevenue > 0 || purchaseRevenue > 0 || transactions > 0) {
      observedRevenue = true;
    }
    rows.push({
      id: await deterministicGa4FactId({
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        date,
        grain: "summary",
        grainKey: "",
      }),
      projectId: ctx.projectId,
      propertyId: ctx.propertyId,
      ga4ConnectionId: ctx.connectionId,
      date,
      sessions,
      engagedSessions,
      userEngagementDuration,
      screenPageViews,
      eventCount,
      newUsers,
      totalUsers,
      activeUsers,
      totalRevenue,
      purchaseRevenue,
      transactions,
      addToCarts,
      checkouts,
    });
  }
  return { rows, observedRevenue };
}

async function normalizeAcquisitionResponse(
  response: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
): Promise<Ga4AcquisitionInsert[]> {
  const rows: Ga4AcquisitionInsert[] = [];
  for (const row of response.rows) {
    const date = toIsoDate(row.dimensionValues[0] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    const channel = canonicalGa4Dimension(row.dimensionValues[1]);
    const source = canonicalGa4Dimension(row.dimensionValues[2]);
    const medium = canonicalGa4Dimension(row.dimensionValues[3]);
    const ints = parseInts(row.metricValues, 6);
    const duration = toFloatNumber(row.metricValues[2]);
    if (!ints || duration === null) {
      failDate(failed, "acquisition", date);
      failRow();
      continue;
    }
    const [sessions, engagedSessions, , screenPageViews, eventCount, newUsers] =
      ints;
    rows.push({
      id: await deterministicGa4FactId({
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        date,
        grain: "acquisition",
        grainKey: `${channel}|${source}|${medium}`,
      }),
      projectId: ctx.projectId,
      propertyId: ctx.propertyId,
      ga4ConnectionId: ctx.connectionId,
      date,
      channelGroup: channel,
      source,
      medium,
      rawChannelGroup: row.dimensionValues[1] ?? null,
      rawSource: row.dimensionValues[2] ?? null,
      rawMedium: row.dimensionValues[3] ?? null,
      sessions,
      engagedSessions,
      userEngagementDuration: duration,
      screenPageViews,
      eventCount,
      newUsers,
    });
  }
  return rows;
}

async function normalizeLandingResponse(
  response: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
): Promise<Ga4LandingInsert[]> {
  const rows: Ga4LandingInsert[] = [];
  for (const row of response.rows) {
    const date = toIsoDate(row.dimensionValues[0] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    const raw = row.dimensionValues[1] ?? "";
    const page = normalizeGa4LandingPage(raw);
    const ints = parseInts(row.metricValues, 4);
    const duration = toFloatNumber(row.metricValues[2]);
    if (!ints || duration === null) {
      failDate(failed, "landing_pages", date);
      failRow();
      continue;
    }
    const [sessions, engagedSessions, , screenPageViews] = ints;
    rows.push({
      id: await deterministicGa4FactId({
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        date,
        grain: "landing_pages",
        grainKey: page,
      }),
      projectId: ctx.projectId,
      propertyId: ctx.propertyId,
      ga4ConnectionId: ctx.connectionId,
      date,
      landingPage: page,
      rawLandingPage: raw,
      sessions,
      engagedSessions,
      userEngagementDuration: duration,
      screenPageViews,
    });
  }
  return rows;
}

async function normalizeEventsResponse(
  response: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
): Promise<Ga4EventInsert[]> {
  const rows: Ga4EventInsert[] = [];
  for (const row of response.rows) {
    const date = toIsoDate(row.dimensionValues[0] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    const eventName = canonicalGa4Dimension(row.dimensionValues[1]);
    const eventCount = toIntNumber(row.metricValues[0] ?? "0");
    const keyEvents = toIntNumber(row.metricValues[1] ?? "0");
    if (eventCount === null || keyEvents === null) {
      failDate(failed, "events", date);
      failRow();
      continue;
    }
    rows.push({
      id: await deterministicGa4FactId({
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        date,
        grain: "events",
        grainKey: eventName,
      }),
      projectId: ctx.projectId,
      propertyId: ctx.propertyId,
      ga4ConnectionId: ctx.connectionId,
      date,
      eventName,
      eventCount,
      isKeyEvent: keyEvents > 0,
    });
  }
  return rows;
}

/** Normalize one chunk's five batch sub-responses (summary-core, summary
 *  revenue, acquisition, landing pages, events) plus the two individually
 *  fetched geo/technology reports into storage rows plus per-unit coverage
 *  outcomes. Throws QuotaHaltError when any sub-request reports quota
 *  exhaustion; other sub-request errors fail only their grain. */
export async function normalizeChunkResponses(input: {
  projectId: string;
  propertyId: string;
  connectionId: string | null;
  chunk: DateChunk;
  responses: Array<Ga4ReportResult | Ga4ApiError>;
  limits: number[];
  tailCountsKnown?: { geo: boolean; technology: boolean };
}): Promise<ChunkNormalization> {
  const {
    projectId,
    propertyId,
    connectionId,
    chunk,
    responses,
    limits,
    tailCountsKnown,
  } = input;
  if (responses.length !== GA4_CHUNK_RESPONSE_COUNT) {
    throw new Error("GA4 chunk response count mismatch");
  }
  const chunkDates = new Set(eachDayUtc(chunk.startDate, chunk.endDate));
  const failed: FailedDates = new Map();
  let fetched = 0;
  let failedCount = 0;
  const failRow = () => {
    failedCount += 1;
  };
  let observedRevenue = false;
  let observedCurrency: string | null = null;
  const observeCurrency = (response: Ga4ReportResult) => {
    if (observedCurrency === null && response.metadata.currencyCode) {
      observedCurrency = response.metadata.currencyCode;
    }
  };
  let firstError: { errorClass: string; message: string } | null = null;

  const checkGrainError = (
    grain: Ga4SyncGrain,
    response: Ga4ReportResult | Ga4ApiError,
  ): Ga4ReportResult | null => {
    if (response instanceof Ga4ApiError) {
      const classification = classifyGa4Error(response);
      if (classification.errorClass === "QUOTA_EXHAUSTED") {
        throw new QuotaHaltError("quota exhausted mid-batch");
      }
      if (!firstError) {
        firstError = {
          errorClass: classification.errorClass,
          message: classification.message,
        };
      }
      for (const date of chunkDates) failDate(failed, grain, date);
      return null;
    }
    return response;
  };

  const ctx: GrainContext = {
    projectId,
    propertyId,
    connectionId,
    chunkDates,
  };

  const grainResult = (
    grain: Ga4SyncGrain,
    response: Ga4ReportResult | Ga4ApiError,
  ): Ga4ReportResult | null => checkGrainError(grain, response);

  const summaryCore = grainResult("summary", responses[0]);
  const summaryRevenue = grainResult("summary", responses[1]);
  let summaryRows: Ga4SummaryInsert[] = [];
  if (summaryCore && summaryRevenue) {
    observeCurrency(summaryCore);
    observeCurrency(summaryRevenue);
    fetched += summaryCore.rows.length + summaryRevenue.rows.length;
    const normalized = await normalizeSummaryResponses(
      summaryCore,
      summaryRevenue,
      ctx,
      failed,
      failRow,
    );
    summaryRows = normalized.rows;
    if (normalized.observedRevenue) observedRevenue = true;
  }

  const acquisitionResponse = grainResult("acquisition", responses[2]);
  let acquisitionRows: Ga4AcquisitionInsert[] = [];
  let acquisitionTruncation: Ga4TruncationMeta | null = null;
  if (acquisitionResponse) {
    observeCurrency(acquisitionResponse);
    fetched += acquisitionResponse.rows.length;
    acquisitionTruncation = truncationFor(acquisitionResponse, limits[2]);
    acquisitionRows = await normalizeAcquisitionResponse(
      acquisitionResponse,
      ctx,
      failed,
      failRow,
    );
  }

  const landingResponse = grainResult("landing_pages", responses[3]);
  let landingRows: Ga4LandingInsert[] = [];
  let landingTruncation: Ga4TruncationMeta | null = null;
  if (landingResponse) {
    observeCurrency(landingResponse);
    fetched += landingResponse.rows.length;
    landingTruncation = truncationFor(landingResponse, limits[3]);
    landingRows = await normalizeLandingResponse(
      landingResponse,
      ctx,
      failed,
      failRow,
    );
  }

  const eventsResponse = grainResult("events", responses[4]);
  let eventRows: Ga4EventInsert[] = [];
  let eventsTruncation: Ga4TruncationMeta | null = null;
  if (eventsResponse) {
    observeCurrency(eventsResponse);
    fetched += eventsResponse.rows.length;
    eventsTruncation = truncationFor(eventsResponse, limits[4]);
    eventRows = await normalizeEventsResponse(
      eventsResponse,
      ctx,
      failed,
      failRow,
    );
  }

  const geoResponse = grainResult("geo", responses[5]);
  let geoRows: Ga4GeoInsert[] = [];
  const geoTailMetas = new Map<string, Ga4TruncationMeta>();
  if (geoResponse) {
    observeCurrency(geoResponse);
    fetched += geoResponse.rows.length;
    const normalized = await normalizeGeoResponse(
      geoResponse,
      ctx,
      failed,
      failRow,
      tailCountsKnown?.geo ?? false,
    );
    geoRows = normalized.rows;
    for (const outcome of normalized.outcomes) {
      geoTailMetas.set(outcome.date, outcome.truncationMeta);
    }
  }

  const techResponse = grainResult("technology", responses[6]);
  let technologyRows: Ga4TechnologyInsert[] = [];
  const techTailMetas = new Map<string, Ga4TruncationMeta>();
  if (techResponse) {
    observeCurrency(techResponse);
    fetched += techResponse.rows.length;
    const normalized = await normalizeTechResponse(
      techResponse,
      ctx,
      failed,
      failRow,
      tailCountsKnown?.technology ?? false,
    );
    technologyRows = normalized.rows;
    for (const outcome of normalized.outcomes) {
      techTailMetas.set(outcome.date, outcome.truncationMeta);
    }
  }

  const truncations = new Map([
    ["acquisition", acquisitionTruncation],
    ["landing_pages", landingTruncation],
    ["events", eventsTruncation],
  ] as Array<[Ga4SyncGrain, Ga4TruncationMeta | null]>);

  const outcomes: UnitOutcome[] = [];
  for (const date of chunkDates) {
    for (const grain of [
      "summary",
      "acquisition",
      "landing_pages",
      "events",
      "geo",
      "technology",
    ] as Ga4SyncGrain[]) {
      if (failed.get(grain)?.has(date)) {
        outcomes.push({ date, grain, status: "FAILED" });
        continue;
      }
      const tailMeta =
        grain === "geo"
          ? (geoTailMetas.get(date) ?? null)
          : grain === "technology"
            ? (techTailMetas.get(date) ?? null)
            : null;
      const hasRows =
        (grain === "summary" && summaryRows.some((row) => row.date === date)) ||
        (grain === "acquisition" &&
          acquisitionRows.some((row) => row.date === date)) ||
        (grain === "landing_pages" &&
          landingRows.some((row) => row.date === date)) ||
        (grain === "events" && eventRows.some((row) => row.date === date)) ||
        (grain === "geo" && geoRows.some((row) => row.date === date)) ||
        (grain === "technology" &&
          technologyRows.some((row) => row.date === date));
      outcomes.push({
        date,
        grain,
        status: hasRows ? "SUCCESS_WITH_DATA" : "SUCCESS_ZERO_ROWS",
        truncationMeta: tailMeta ?? truncations.get(grain) ?? null,
      });
    }
  }

  return {
    summaryRows,
    acquisitionRows,
    landingRows,
    eventRows,
    geoRows,
    technologyRows,
    outcomes,
    fetched,
    failed: failedCount,
    observedRevenue,
    observedCurrency,
    ...(firstError ? { firstError } : {}),
  };
}

type BoundedGrainParse = {
  rows: Array<{ date: string; key: string; metrics: Ga4TailMetrics }>;
};

function parseBoundedGrainRows(input: {
  response: Ga4ReportResult;
  dims: { date: number; parts: number[] };
  grain: "geo" | "technology";
  ctx: GrainContext;
  failed: FailedDates;
  failRow: () => void;
}): BoundedGrainParse {
  const { response, dims, grain, ctx, failed, failRow } = input;
  const rows: BoundedGrainParse["rows"] = [];
  for (const row of response.rows) {
    const date = toIsoDate(row.dimensionValues[dims.date] ?? "");
    if (!date || !ctx.chunkDates.has(date)) {
      failRow();
      continue;
    }
    const parts = dims.parts.map((index) =>
      canonicalGa4Dimension(row.dimensionValues[index]),
    );
    const ints = parseInts(row.metricValues, 6);
    const duration = toFloatNumber(row.metricValues[2]);
    if (!ints || duration === null) {
      failDate(failed, grain, date);
      failRow();
      continue;
    }
    const [sessions, engagedSessions, , screenPageViews, eventCount, newUsers] =
      ints;
    rows.push({
      date,
      key: parts.join("|"),
      metrics: {
        sessions,
        engagedSessions,
        userEngagementDuration: duration,
        screenPageViews,
        eventCount,
        newUsers,
      },
    });
  }
  return { rows };
}

type BoundedGrainOutcome = {
  date: string;
  kept: Array<{ key: string; metrics: Ga4TailMetrics; isOther: boolean }>;
  truncationMeta: Ga4TruncationMeta;
};

function rollUpBoundedGrain(
  parsed: BoundedGrainParse,
  input: { topN: number; countsKnown: boolean; samplingState: "SAMPLED" | "NOT_SAMPLED" | null },
): BoundedGrainOutcome[] {
  const byDate = new Map<string, Array<{ key: string; metrics: Ga4TailMetrics }>>();
  for (const row of parsed.rows) {
    let list = byDate.get(row.date);
    if (!list) {
      list = [];
      byDate.set(row.date, list);
    }
    list.push({ key: row.key, metrics: row.metrics });
  }
  const outcomes: BoundedGrainOutcome[] = [];
  for (const [date, dateRows] of byDate) {
    const rollup = rollUpOtherTail({
      rows: dateRows,
      topN: input.topN,
      countsKnown: input.countsKnown,
    });
    outcomes.push({
      date,
      kept: [
        ...rollup.retained.map((row) => ({ ...row, isOther: false })),
        ...(rollup.other
          ? [{ key: GA4_OTHER_DIMENSION, metrics: rollup.other, isOther: true }]
          : []),
      ],
      truncationMeta: {
        row_limit: input.topN,
        rows_returned: dateRows.length,
        is_truncated: rollup.isTruncated,
        total_rows_if_known: input.countsKnown ? dateRows.length : null,
        sampling_state: input.samplingState,
        data_loss_from_other_row: null,
        retained_dimension_count: rollup.retainedDimensionCount,
        omitted_dimension_count: rollup.omittedDimensionCount,
        other_row_present: rollup.otherRowPresent,
      },
    });
  }
  return outcomes;
}

async function normalizeGeoResponse(
  response: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
  countsKnown: boolean,
): Promise<{ rows: Ga4GeoInsert[]; outcomes: BoundedGrainOutcome[] }> {
  const parsed = parseBoundedGrainRows({
    response,
    dims: { date: 0, parts: [1] },
    grain: "geo",
    ctx,
    failed,
    failRow,
  });
  const rolled = rollUpBoundedGrain(parsed, {
    topN: GA4_GEO_TOP_N,
    countsKnown,
    samplingState: response.metadata.samplingState,
  });
  const rows: Ga4GeoInsert[] = [];
  for (const outcome of rolled) {
    for (const kept of outcome.kept) {
      rows.push({
        id: await deterministicGa4FactId({
          projectId: ctx.projectId,
          propertyId: ctx.propertyId,
          date: outcome.date,
          grain: "geo",
          grainKey: kept.key,
        }),
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        ga4ConnectionId: ctx.connectionId,
        date: outcome.date,
        country: kept.isOther ? GA4_OTHER_DIMENSION : kept.key,
        sessions: kept.metrics.sessions,
        engagedSessions: kept.metrics.engagedSessions,
        userEngagementDuration: kept.metrics.userEngagementDuration,
        screenPageViews: kept.metrics.screenPageViews,
        eventCount: kept.metrics.eventCount,
        newUsers: kept.metrics.newUsers,
        isOtherRow: kept.isOther,
      });
    }
  }
  return { rows, outcomes: rolled };
}

async function normalizeTechResponse(
  response: Ga4ReportResult,
  ctx: GrainContext,
  failed: FailedDates,
  failRow: () => void,
  countsKnown: boolean,
): Promise<{ rows: Ga4TechnologyInsert[]; outcomes: BoundedGrainOutcome[] }> {
  const parsed = parseBoundedGrainRows({
    response,
    dims: { date: 0, parts: [1, 2, 3] },
    grain: "technology",
    ctx,
    failed,
    failRow,
  });
  const rolled = rollUpBoundedGrain(parsed, {
    topN: GA4_TECHNOLOGY_TOP_N,
    countsKnown,
    samplingState: response.metadata.samplingState,
  });
  const rows: Ga4TechnologyInsert[] = [];
  for (const outcome of rolled) {
    for (const kept of outcome.kept) {
      const [device, browser, os] = kept.isOther
        ? [GA4_OTHER_DIMENSION, GA4_OTHER_DIMENSION, GA4_OTHER_DIMENSION]
        : kept.key.split("|");
      rows.push({
        id: await deterministicGa4FactId({
          projectId: ctx.projectId,
          propertyId: ctx.propertyId,
          date: outcome.date,
          grain: "technology",
          grainKey: kept.key,
        }),
        projectId: ctx.projectId,
        propertyId: ctx.propertyId,
        ga4ConnectionId: ctx.connectionId,
        date: outcome.date,
        device: device ?? GA4_OTHER_DIMENSION,
        browser: browser ?? GA4_OTHER_DIMENSION,
        os: os ?? GA4_OTHER_DIMENSION,
        sessions: kept.metrics.sessions,
        engagedSessions: kept.metrics.engagedSessions,
        userEngagementDuration: kept.metrics.userEngagementDuration,
        screenPageViews: kept.metrics.screenPageViews,
        eventCount: kept.metrics.eventCount,
        newUsers: kept.metrics.newUsers,
        isOtherRow: kept.isOther,
      });
    }
  }
  return { rows, outcomes: rolled };
}
/** Fetch follow-up offset pages for a full first page (all grains except
 *  landing pages, which are top-N bounded by design). */
export async function fetchGrainPages(
  client: ReturnType<typeof createGa4Client>,
  base: Ga4GrainSubRequest,
  first: Ga4ReportResult,
  paginate: boolean,
): Promise<{ pages: Ga4ReportResult[]; truncated: boolean }> {
  const pages = [first];
  const totalKnown = first.rowCount ?? first.rows.length;
  if (!paginate) {
    return { pages, truncated: totalKnown > first.rows.length };
  }
  let fetched = first.rows.length;
  while (totalKnown > fetched && pages.length < GA4_REPORT_MAX_PAGES) {
    const page = await client.runReport({ ...base, offset: fetched });
    pages.push(page);
    fetched += page.rows.length;
    if (page.rows.length === 0) break;
  }
  return { pages, truncated: totalKnown > fetched };
}
