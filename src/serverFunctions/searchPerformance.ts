import { createServerFn } from "@tanstack/react-start";
import {
  GscNotConnectedError,
  GscService,
  isExpectedGrantFailure,
} from "@/server/features/gsc/services/GscService";
import {
  resolveDateRange,
  sixteenMonthFloor,
  type GscPerformanceFilter,
} from "@/server/features/gsc/searchAnalytics";
import {
  buildStrikingDistanceRows,
  previousPeriod,
  sumSearchTotals,
  toDimensionRows,
} from "@/server/features/gsc/searchPerformanceReport";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  searchPerformanceInputSchema,
  searchPerformanceSyncInputSchema,
  searchPerformanceSyncStatusInputSchema,
  searchPerformanceTableExportInputSchema,
  searchPerformanceTableInputSchema,
} from "@/types/schemas/search-performance";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { GscSyncService } from "@/server/features/gsc/services/GscSyncService";

// query x page fan-out needs more rows to find the 5..20 band.
const STRIKING_DISTANCE_FETCH_LIMIT = 1000;
// dimensions:["date"] returns one row per day; 16 months is ~488 days.
const DAILY_ROW_LIMIT = 1000;
const COUNTRY_ROW_LIMIT = 25;
// Export pulls the whole dimension in one shot, capped at GSC's per-call max
// (GSC_MAX_ROW_LIMIT). Large stores get everything up to this ceiling.
const EXPORT_ROW_LIMIT = 1000;

/** Build GSC filter groups shared by every call. Device applies everywhere;
 *  country applies everywhere except the country breakdown itself (so the
 *  dropdown keeps every option visible while one country is selected). */
function buildGscFilters(data: { device?: string; country?: string }): {
  deviceFilters: GscPerformanceFilter[];
  filters: GscPerformanceFilter[];
} {
  const deviceFilters: GscPerformanceFilter[] = data.device
    ? [{ dimension: "device", operator: "equals", expression: data.device }]
    : [];
  const filters: GscPerformanceFilter[] = data.country
    ? [
        ...deviceFilters,
        { dimension: "country", operator: "equals", expression: data.country },
      ]
    : deviceFilters;
  return { deviceFilters, filters };
}

/** Not connected, or a dead/denied grant (token failure or 401/403): the page
 *  renders the connect card. Other statuses (429, 5xx) are real faults. */
function isExpectedConnectionFailure(error: unknown): boolean {
  return error instanceof GscNotConnectedError || isExpectedGrantFailure(error);
}

/**
 * The Search Performance overview:
 * 1. Database-first: reads stored normalized facts when available.
 * 2. Controlled fallback: queries live GSC when date range is not yet stored.
 */
export const getSearchPerformanceReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchPerformanceInputSchema)
  .handler(async ({ data, context }) => {
    const { startDate, endDate } = resolveDateRange({
      dateRange: data.dateRange,
    });
    const prev = previousPeriod(startDate, endDate);
    const projectId = context.projectId;
    const { deviceFilters, filters } = buildGscFilters(data);
    const floor = sixteenMonthFloor();
    const hasPrevious = prev.endDate > floor;

    // Check DB coverage and sync state
    const [hasCoverage, latestSync, activeSync, storedCoverage] =
      await Promise.all([
        GscSearchPerformanceRepository.hasCoverage(
          projectId,
          startDate,
          endDate,
        ),
        GscSearchPerformanceRepository.getLatestSyncRun(projectId),
        GscSearchPerformanceRepository.getActiveSyncRun(projectId),
        GscSearchPerformanceRepository.getStoredCoverageRange(projectId),
      ]);

    const syncCoverage = (() => {
      if (!latestSync && !storedCoverage) return null;

      const covStartDate =
        storedCoverage?.startDate ??
        (latestSync?.status === "completed"
          ? latestSync.requestedStartDate
          : latestSync?.actualLastSuccessfulDate ?? null);
      const covEndDate =
        storedCoverage?.endDate ??
        (latestSync?.status === "completed"
          ? latestSync.requestedEndDate
          : latestSync?.actualLastSuccessfulDate ?? null);

      let status: "completed" | "partial" | "failed" | "running" = "completed";
      if (activeSync !== null) {
        status = "running";
      } else if (latestSync?.status === "failed") {
        status = "failed";
      } else if (storedCoverage && storedCoverage.endDate < endDate) {
        status = "partial";
      } else if (latestSync?.status === "partial") {
        status = "partial";
      } else if (latestSync?.status === "completed") {
        status = "completed";
      }

      return {
        status,
        startDate: covStartDate,
        endDate: covEndDate,
        rowsFetched: latestSync?.rowsFetched ?? 0,
        rowsInserted: latestSync?.rowsInserted ?? 0,
        isPartialRecent:
          storedCoverage !== null && storedCoverage.endDate < endDate,
      };
    })();

    if (hasCoverage) {
      const [totals, prevTotals, strikingDistance, countries] =
        await Promise.all([
          GscSearchPerformanceRepository.getTotals(
            projectId,
            startDate,
            endDate,
            {
              device: data.device,
              country: data.country,
            },
          ),
          hasPrevious
            ? GscSearchPerformanceRepository.getTotals(
                projectId,
                prev.startDate,
                prev.endDate,
                {
                  device: data.device,
                  country: data.country,
                },
              )
            : Promise.resolve({
                clicks: 0,
                impressions: 0,
                ctr: 0,
                position: 0,
              }),
          GscSearchPerformanceRepository.getStrikingDistance(
            projectId,
            startDate,
            endDate,
          ),
          GscSearchPerformanceRepository.getCountries(
            projectId,
            startDate,
            endDate,
          ),
        ]);

      return {
        connected: true as const,
        source: "database" as const,
        coverage: true as const,
        lastSyncedAt: latestSync?.completedAt ?? null,
        isSyncRunning: activeSync !== null,
        syncCoverage,
        range: {
          startDate,
          endDate,
          prevStartDate: prev.startDate,
          prevEndDate: prev.endDate,
        },
        totals,
        prevTotals,
        strikingDistance,
        countries,
      };
    }

    // Controlled live GSC fallback when database is not yet synchronized
    try {
      const [current, previous, queryPages, countries] = await Promise.all([
        GscService.getPerformance({
          projectId,
          startDate,
          endDate,
          dimensions: ["date"],
          filters,
          rowLimit: DAILY_ROW_LIMIT,
        }),
        hasPrevious
          ? GscService.getPerformance({
              projectId,
              startDate: prev.startDate,
              endDate: prev.endDate,
              dimensions: ["date"],
              filters,
              rowLimit: DAILY_ROW_LIMIT,
            })
          : Promise.resolve({ rows: [] }),
        GscService.getPerformance({
          projectId,
          startDate,
          endDate,
          dimensions: ["query", "page"],
          filters,
          rowLimit: STRIKING_DISTANCE_FETCH_LIMIT,
        }),
        GscService.getPerformance({
          projectId,
          startDate,
          endDate,
          dimensions: ["country"],
          filters: deviceFilters,
          rowLimit: COUNTRY_ROW_LIMIT,
        }),
      ]);

      return {
        connected: true as const,
        source: "live_fallback" as const,
        coverage: false as const,
        lastSyncedAt: latestSync?.completedAt ?? null,
        isSyncRunning: activeSync !== null,
        syncCoverage,
        range: {
          startDate,
          endDate,
          prevStartDate: prev.startDate,
          prevEndDate: prev.endDate,
        },
        totals: sumSearchTotals(current.rows),
        prevTotals: sumSearchTotals(previous.rows),
        strikingDistance: buildStrikingDistanceRows(queryPages.rows),
        countries: toDimensionRows(countries.rows),
      };
    } catch (error) {
      if (isExpectedConnectionFailure(error)) {
        return { connected: false as const };
      }
      throw error;
    }
  });

/**
 * One page of the queries or pages table. Reads from DB first when available.
 */
export const getSearchPerformanceTable = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchPerformanceTableInputSchema)
  .handler(async ({ data, context }) => {
    const { startDate, endDate } = resolveDateRange({
      dateRange: data.dateRange,
    });
    const projectId = context.projectId;

    const hasCoverage = await GscSearchPerformanceRepository.hasCoverage(
      projectId,
      startDate,
      endDate,
    );

    if (hasCoverage && !data.device && !data.country) {
      const result = await GscSearchPerformanceRepository.getTableRows({
        projectId,
        dimension: data.dimension,
        startDate,
        endDate,
        page: data.page,
        pageSize: data.pageSize,
      });

      return {
        connected: true as const,
        source: "database" as const,
        dimension: data.dimension,
        page: data.page,
        pageSize: data.pageSize,
        hasNextPage: result.hasNextPage,
        rows: result.rows,
      };
    }

    const { filters } = buildGscFilters(data);
    const offset = (data.page - 1) * data.pageSize;

    try {
      const result = await GscService.getPerformance({
        projectId: context.projectId,
        startDate,
        endDate,
        dimensions: [data.dimension],
        filters,
        rowLimit: data.pageSize + 1,
        startRow: offset,
      });

      const fetched = toDimensionRows(result.rows);
      const hasNextPage = fetched.length > data.pageSize;
      const rows = hasNextPage ? fetched.slice(0, data.pageSize) : fetched;

      return {
        connected: true as const,
        source: hasCoverage
          ? ("database" as const)
          : ("live_fallback" as const),
        dimension: data.dimension,
        page: data.page,
        pageSize: data.pageSize,
        hasNextPage,
        rows,
      };
    } catch (error) {
      if (isExpectedConnectionFailure(error)) {
        return { connected: false as const };
      }
      throw error;
    }
  });

/**
 * Full queries/pages dataset for CSV/Sheets export (capped at EXPORT_ROW_LIMIT).
 */
export const exportSearchPerformanceTable = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchPerformanceTableExportInputSchema)
  .handler(async ({ data, context }) => {
    const { startDate, endDate } = resolveDateRange({
      dateRange: data.dateRange,
    });
    const projectId = context.projectId;

    const hasCoverage = await GscSearchPerformanceRepository.hasCoverage(
      projectId,
      startDate,
      endDate,
    );

    if (hasCoverage && !data.device && !data.country) {
      const result = await GscSearchPerformanceRepository.getTableRows({
        projectId,
        dimension: data.dimension,
        startDate,
        endDate,
        page: 1,
        pageSize: EXPORT_ROW_LIMIT,
      });

      return {
        dimension: data.dimension,
        rows: result.rows,
      };
    }

    const { filters } = buildGscFilters(data);

    const result = await GscService.getPerformance({
      projectId: context.projectId,
      startDate,
      endDate,
      dimensions: [data.dimension],
      filters,
      rowLimit: EXPORT_ROW_LIMIT,
    });

    return {
      dimension: data.dimension,
      rows: toDimensionRows(result.rows),
    };
  });

/**
 * Trigger an on-demand sync for a project and date window.
 */
export const triggerSearchPerformanceSync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchPerformanceSyncInputSchema)
  .handler(async ({ data, context }) => {
    let startDate = data.startDate;
    let endDate = data.endDate;

    if (data.dateRange) {
      const resolved = resolveDateRange({ dateRange: data.dateRange });
      startDate = resolved.startDate;
      endDate = resolved.endDate;
    }

    return GscSyncService.runSync({
      projectId: context.projectId,
      syncType: data.syncType,
      startDate,
      endDate,
    });
  });

/**
 * Get current sync status and latest completed sync metadata for a project.
 */
export const getSearchPerformanceSyncStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchPerformanceSyncStatusInputSchema)
  .handler(async ({ data }) => {
    const [latest, active] = await Promise.all([
      GscSearchPerformanceRepository.getLatestSyncRun(data.projectId),
      GscSearchPerformanceRepository.getActiveSyncRun(data.projectId),
    ]);

    return {
      latestSync: latest,
      activeSync: active,
      isRunning: active !== null,
    };
  });
