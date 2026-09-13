import { db } from "@/db";
import { gscConnections } from "@/db/schema";
import { GscSyncService } from "@/server/features/gsc/services/GscSyncService";

export async function runScheduledGscSync(): Promise<void> {
  let connections: Array<{ projectId: string; siteUrl: string }>;
  try {
    connections = await db
      .select({
        projectId: gscConnections.projectId,
        siteUrl: gscConnections.siteUrl,
      })
      .from(gscConnections);
  } catch (err) {
    console.error("[cron:gsc] Failed to list connected GSC properties:", err);
    return;
  }

  for (const conn of connections) {
    try {
      console.log(
        `[cron:gsc] Starting incremental sync for project ${conn.projectId} (${conn.siteUrl})`,
      );
      const result = await GscSyncService.runSync({
        projectId: conn.projectId,
        syncType: "incremental",
      });

      if (result.ok) {
        console.log(
          `[cron:gsc] Completed incremental sync for project ${conn.projectId}: ${result.rowsInserted} rows inserted across ${result.chunksCompleted} chunks`,
        );
      } else if (result.alreadyRunning) {
        console.log(
          `[cron:gsc] Project ${conn.projectId} already has an active sync in progress; skipping`,
        );
      } else {
        console.warn(
          `[cron:gsc] Sync for project ${conn.projectId} ended with status ${result.status}: ${result.error}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron:gsc] Uncaught error syncing project ${conn.projectId}:`,
        err,
      );
    }
  }
}
