import { createServerFn } from "@tanstack/react-start";
import { GscSyncService } from "@/server/features/gsc/services/GscSyncService";
import { resolveDateRange } from "@/server/features/gsc/searchAnalytics";
import { searchPerformanceSyncInputSchema } from "@/types/schemas/search-performance";
import { requireProjectContext } from "./middleware";

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
