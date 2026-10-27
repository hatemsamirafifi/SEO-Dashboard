import { db } from "@/db";
import { googleAdsConnections } from "@/db/schema";
import { GoogleAdsSyncRepository } from "../repositories/GoogleAdsSyncRepository";
import { GoogleAdsSyncService } from "./GoogleAdsSyncService";
import { GOOGLE_ADS_SYNC_MIN_INTERVAL_MS } from "./googleAdsSyncUtils";

/** Cron entry for the Google Ads durable sync. Like the GA4 cron, each
 *  connected project is checked for an active run and a 6h floor before the
 *  sync service is invoked; every project stays isolated in its own
 *  try/catch so one failing account never blocks the rest of the cron. */
export async function runScheduledGoogleAdsSync(): Promise<void> {
  let connections: Array<{
    projectId: string;
    organizationId: string;
    customerId: string;
  }>;
  try {
    connections = await db
      .select({
        projectId: googleAdsConnections.projectId,
        organizationId: googleAdsConnections.organizationId,
        customerId: googleAdsConnections.customerId,
      })
      .from(googleAdsConnections);
  } catch (err) {
    console.error("[cron:google-ads] Failed to list connected projects:", err);
    return;
  }

  for (const conn of connections) {
    try {
      const history = await GoogleAdsSyncRepository.getRunHistory(
        {
          projectId: conn.projectId,
          organizationId: conn.organizationId,
          customerId: conn.customerId,
        },
        { limit: 1 },
      );
      const latest = history[0] ?? null;
      if (
        latest &&
        (latest.status === "pending" || latest.status === "running")
      ) {
        console.log(
          `[cron:google-ads] Project ${conn.projectId} already has an active sync run; skipping`,
        );
        continue;
      }
      // startedAt is always written as an ISO-8601 instant, so the floor
      // comparison is chronological on both storage dialects.
      if (
        latest &&
        Date.parse(latest.startedAt) >
          Date.now() - GOOGLE_ADS_SYNC_MIN_INTERVAL_MS
      ) {
        console.log(
          `[cron:google-ads] Project ${conn.projectId} synced within the 6h floor; skipping`,
        );
        continue;
      }
      console.log(
        `[cron:google-ads] Starting Google Ads sync for project ${conn.projectId} (customer ${conn.customerId})`,
      );
      const result = await GoogleAdsSyncService.runSync({
        projectId: conn.projectId,
        organizationId: conn.organizationId,
        mode: "scheduled",
      });

      if (result.ok) {
        console.log(
          `[cron:google-ads] Completed sync for project ${conn.projectId}: ${result.unitsSucceeded} units published (${result.status})`,
        );
      } else if (result.alreadyRunning) {
        console.log(
          `[cron:google-ads] Project ${conn.projectId} already has an active sync run; skipping`,
        );
      } else {
        console.warn(
          `[cron:google-ads] Sync for project ${conn.projectId} ended with status ${result.status}: ${result.errorClass ?? "no error recorded"}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron:google-ads] Uncaught error syncing project ${conn.projectId}:`,
        err,
      );
    }
  }
}
