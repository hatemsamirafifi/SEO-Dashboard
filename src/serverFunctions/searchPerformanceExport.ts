import { createServerFn } from "@tanstack/react-start";
import { GscService } from "@/server/features/gsc/services/GscService";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  resolveDateRange,
  type GscPerformanceFilter,
} from "@/server/features/gsc/searchAnalytics";
import { toDimensionRows } from "@/server/features/gsc/searchPerformanceReport";
import { searchPerformanceTableExportInputSchema } from "@/types/schemas/search-performance";
import { requireProjectContext } from "./middleware";

const EXPORT_ROW_LIMIT = 1000;

/** GSC filters for the export path (device/country narrowing). */
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
