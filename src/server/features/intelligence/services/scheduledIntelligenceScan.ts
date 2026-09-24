import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  SourceTokens,
  hasActiveMutations,
  hashSourceState,
  describeActiveMutations,
} from "./SourceTokens";
import { FindingService, SCAN_FLOOR_MS, SCAN_FORCE_MS } from "./FindingService";

/**
 * Intelligence scan scheduler (final-plan §8). Tick cost per project: one
 * indexed ledger read (latest hashed run) + in-memory token assembly —
 * no metric reads unless both predicates pass. Two independent predicates:
 * `changed = inputHash != lastBaselineInputHash` AND
 * `now >= nextEligibleAt` (4h floor), plus a 24h safety force.
 *
 * The baseline is the latest hashed non-failed run (composing runs count):
 * nothing reaches `completed` until Task 11 owns compose, so gating only on
 * terminal runs would rescan stable sources every 15-minute tick.
 */
export async function runScheduledIntelligenceScan(): Promise<void> {
  let targets: Array<{ projectId: string; organizationId: string }>;
  try {
    targets = await ProjectRepository.listUnarchivedProjects();
  } catch (err) {
    console.error("[cron:intelligence] Failed to list projects:", err);
    return;
  }

  for (const target of targets) {
    try {
      const state = await SourceTokens.assembleDetectionSourceState(
        target.projectId,
      );
      if (hasActiveMutations(state)) {
        console.log(
          `[cron:intelligence] Project ${target.projectId} deferred_active_mutation; skipping`,
          describeActiveMutations(state).join(";"),
        );
        continue;
      }
      const baseline = await ScanLedgerRepository.getLatestHashedRun(
        target.projectId,
      );
      const now = Date.now();
      const baselineAt = baseline?.completedAt ?? baseline?.updatedAt;
      if (baseline?.inputHash && baselineAt) {
        const baselineMs = Date.parse(baselineAt);
        const inputHash = await hashSourceState(state);
        const changed = inputHash !== baseline.inputHash;
        const eligible = now >= baselineMs + SCAN_FLOOR_MS;
        const forced = now >= baselineMs + SCAN_FORCE_MS;
        if (!((changed && eligible) || forced)) {
          continue;
        }
      }
      console.log(
        `[cron:intelligence] Starting scan for project ${target.projectId}`,
      );

      const outcome = await FindingService.runScan({
        projectId: target.projectId,
        organizationId: target.organizationId,
        triggeredBy: "cron",
      });
      if (outcome.ok) {
        console.log(
          `[cron:intelligence] Scan advanced to composing for project ${target.projectId}: ` +
            `${outcome.findingsCount} findings`,
        );
      } else if (!outcome.ok && outcome.deferred === "active_mutation") {
        console.log(
          `[cron:intelligence] Project ${target.projectId} deferred_active_mutation during scan`,
        );
      } else {
        console.warn(
          `[cron:intelligence] Scan failed for project ${target.projectId}: ${outcome.run.error}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron:intelligence] Uncaught error scanning project ${target.projectId}:`,
        err,
      );
    }
  }
}
