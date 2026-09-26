import { db } from "@/db";
import { ga4Connections } from "@/db/schema";
import { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";
import { Ga4SyncService } from "./Ga4SyncService";
import { GA4_SYNC_MIN_INTERVAL_MS } from "./ga4SyncUtils";

export async function runScheduledGa4Sync(): Promise<void> {
  let connections: Array<{
    projectId: string;
    organizationId: string;
    propertyId: string;
  }>;
  try {
    connections = await db
      .select({
        projectId: ga4Connections.projectId,
        organizationId: ga4Connections.organizationId,
        propertyId: ga4Connections.propertyId,
      })
      .from(ga4Connections);
  } catch (err) {
    console.error("[cron:ga4] Failed to list connected GA4 properties:", err);
    return;
  }

  for (const conn of connections) {
    try {
      const [active, latest] = await Promise.all([
        Ga4SyncRepository.getActiveSyncRun(conn.projectId, conn.propertyId),
        Ga4SyncRepository.getLatestSyncRun(conn.projectId, conn.propertyId),
      ]);
      if (active) {
        console.log(
          `[cron:ga4] Project ${conn.projectId} already has an active sync in progress; skipping`,
        );
        continue;
      }
      // startedAt is always written as ISO-8601 (see createSyncRun), so the
      // floor comparison is chronological on both dialects.
      if (
        latest &&
        Date.parse(latest.startedAt) > Date.now() - GA4_SYNC_MIN_INTERVAL_MS
      ) {
        console.log(
          `[cron:ga4] Project ${conn.projectId} synced within the 6h floor; skipping`,
        );
        continue;
      }
      console.log(
        `[cron:ga4] Starting incremental sync for project ${conn.projectId} (property ${conn.propertyId})`,
      );
      const result = await Ga4SyncService.runSync({
        projectId: conn.projectId,
        organizationId: conn.organizationId,
        syncType: "incremental",
      });

      if (result.ok) {
        console.log(
          `[cron:ga4] Completed incremental sync for project ${conn.projectId}: ${result.successfulUnits} units across ${result.chunksCompleted} chunks`,
        );
      } else if (result.alreadyRunning) {
        console.log(
          `[cron:ga4] Project ${conn.projectId} already has an active sync in progress; skipping`,
        );
      } else {
        console.warn(
          `[cron:ga4] Sync for project ${conn.projectId} ended with status ${result.status}: ${result.error}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron:ga4] Uncaught error syncing project ${conn.projectId}:`,
        err,
      );
    }
  }
}
