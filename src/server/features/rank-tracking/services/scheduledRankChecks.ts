/* eslint-disable complexity, max-lines-per-function */
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import { beginRankCheckRun } from "@/server/features/rank-tracking/services/rankCheckRunGuards";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_ID,
  APPROVED_PILOT_TARGET_IDS,
  computeNextCheckAt,
  isScheduledRankTrackingInterval,
  parseUtcTimestampMs,
  WEEKLY_SCHEDULE_MIN_SPACING_MS,
  APPROVED_PILOT_KEYWORD_IDS,
} from "@/shared/rank-tracking";

export {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_KEYWORD_IDS,
  APPROVED_PILOT_KEYWORD_ID,
  APPROVED_PILOT_TARGET_IDS,
  APPROVED_PILOT_REMOTE_SITE_ID,
  APPROVED_PILOT_REMOTE_KEYWORD_ID,
  APPROVED_PILOT_DESKTOP_ENGINE_ID,
  APPROVED_PILOT_MOBILE_ENGINE_ID,
} from "@/shared/rank-tracking";

export const DEFAULT_DAILY_ORG_CHECK_CAP = 50;
export const DEFAULT_MONTHLY_ORG_CHECK_CAP = 500;
export const DEFAULT_MONTHLY_PROJECT_CHECK_CAP = 200;

export const DEFAULT_DAILY_ORG_PAIR_CAP = 1000;
export const DEFAULT_MONTHLY_ORG_PAIR_CAP = 10000;
export const DEFAULT_MONTHLY_PROJECT_PAIR_CAP = 3000;

// Cron body for the `scheduled` Worker handler: start a rank-check run for every
// config that's due. Wrapped in `withPgClient` at the entrypoint (server.ts).
export async function runScheduledRankChecks(env: Env) {
  const nowIso = new Date().toISOString();
  console.log(`[cron] Scheduled rank check tick at ${nowIso}`);

  const dueConfigs =
    await RankTrackingRepository.getDueConfigsWithOrganization(nowIso);
  console.log(
    `[cron] Found ${dueConfigs.length} due rank tracking configuration(s)`,
  );

  const isHosted = await isHostedServerAuthMode();

  const envRecord = env as unknown as Record<string, string | undefined>;
  const pilotEnabled =
    envRecord?.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true" ||
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true";

  const rawAllowlist = envRecord?.SCHEDULED_PILOT_CONFIG_ALLOWLIST?.trim();
  const allowedConfigIds = new Set(
    rawAllowlist
      ? rawAllowlist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [APPROVED_PILOT_CONFIG_ID],
  );

  const dailyOrgCap = Number(
    envRecord?.RANK_TRACKING_DAILY_CHECK_CAP ??
      process.env.RANK_TRACKING_DAILY_CHECK_CAP ??
      DEFAULT_DAILY_ORG_CHECK_CAP,
  );
  const monthlyOrgCap = Number(
    envRecord?.RANK_TRACKING_MONTHLY_CHECK_CAP ??
      process.env.RANK_TRACKING_MONTHLY_CHECK_CAP ??
      DEFAULT_MONTHLY_ORG_CHECK_CAP,
  );
  const monthlyProjectCap = Number(
    envRecord?.RANK_TRACKING_PROJECT_MONTHLY_CAP ??
      process.env.RANK_TRACKING_PROJECT_MONTHLY_CAP ??
      DEFAULT_MONTHLY_PROJECT_CHECK_CAP,
  );

  const dailyOrgPairCap = Number(
    envRecord?.RANK_TRACKING_DAILY_PAIR_CAP ??
      process.env.RANK_TRACKING_DAILY_PAIR_CAP ??
      DEFAULT_DAILY_ORG_PAIR_CAP,
  );
  const monthlyOrgPairCap = Number(
    envRecord?.RANK_TRACKING_MONTHLY_PAIR_CAP ??
      process.env.RANK_TRACKING_MONTHLY_PAIR_CAP ??
      DEFAULT_MONTHLY_ORG_PAIR_CAP,
  );
  const monthlyProjectPairCap = Number(
    envRecord?.RANK_TRACKING_PROJECT_MONTHLY_PAIR_CAP ??
      process.env.RANK_TRACKING_PROJECT_MONTHLY_PAIR_CAP ??
      DEFAULT_MONTHLY_PROJECT_PAIR_CAP,
  );

  for (const config of dueConfigs) {
    try {
      // 1. Skip configs whose org doesn't have a paid plan (hosted mode)
      if (isHosted && !(await customerHasPaidPlan(config.organizationId))) {
        continue;
      }

      // 2. Pilot Authorization Safety Guard (CRITICAL)
      // When pilot mode is not active, skip live execution and leave nextCheckAt untouched
      // so the schedule window is never consumed in the dark.
      if (!pilotEnabled) {
        console.log(
          `[cron] Scheduled rank tracking pilot is disabled (SCHEDULED_RANK_TRACKING_PILOT_ENABLED !== true). Skipping config ${config.id} (${config.domain}) without advancing schedule.`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason:
            "Pilot disabled: configuration awaiting operator activation",
        });
        continue;
      }

      // 3. Strict Pilot Allowlist Guard
      // Only explicitly allowed configurations may run in scheduled pilot mode.
      if (!allowedConfigIds.has(config.id)) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — not in scheduled pilot allowlist`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: "Not in scheduled pilot allowlist",
        });
        continue;
      }

      // 4. Keyword and Target Scope Resolution
      const isPilotConfig = config.id === APPROVED_PILOT_CONFIG_ID;
      const pilotKeywordIds = isPilotConfig
        ? [...APPROVED_PILOT_KEYWORD_IDS]
        : undefined;

      const kwCount = pilotKeywordIds
        ? pilotKeywordIds.length
        : await RankTrackingRepository.getKeywordCountForConfig(config.id);

      if (kwCount === 0) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — no keywords`,
        );
        const skipInterval = isScheduledRankTrackingInterval(
          config.scheduleInterval,
        )
          ? config.scheduleInterval
          : null;
        if (skipInterval) {
          await RankTrackingRepository.updateConfig(
            config.id,
            config.projectId,
            {
              nextCheckAt: computeNextCheckAt(skipInterval, config.nextCheckAt),
            },
          );
        }
        continue;
      }

      // 5. Weekly interval minimum spacing guard (skip if last scheduled run < 6 days ago; manual runs do not block)
      let weeklyMinEligibleMs: number | undefined;
      if (config.scheduleInterval === "weekly") {
        const latestScheduledRun =
          await RankTrackingRepository.getLatestScheduledRunForConfig(
            config.id,
          );
        const lastScheduledTimestamp =
          latestScheduledRun?.completedAt ?? latestScheduledRun?.startedAt;
        const lastScheduledMs = parseUtcTimestampMs(lastScheduledTimestamp);
        weeklyMinEligibleMs = Number.isFinite(lastScheduledMs)
          ? lastScheduledMs + WEEKLY_SCHEDULE_MIN_SPACING_MS
          : undefined;
        if (
          weeklyMinEligibleMs !== undefined &&
          Date.now() < weeklyMinEligibleMs
        ) {
          console.log(
            `[cron] Skipping config ${config.id} (${config.domain}) — weekly interval not elapsed (last scheduled run ${lastScheduledTimestamp})`,
          );
          await RankTrackingRepository.updateConfig(
            config.id,
            config.projectId,
            {
              nextCheckAt: computeNextCheckAt("weekly", config.nextCheckAt, {
                minEligibleMs: weeklyMinEligibleMs,
              }),
            },
          );
          continue;
        }
      }

      // 6. SE Ranking account & project binding health checks
      const accountBinding =
        await SeRankingBindingRepository.getActiveAccountBinding(
          config.organizationId,
        );
      if (
        accountBinding &&
        (accountBinding.status === "migration_required" ||
          accountBinding.status === "disconnected")
      ) {
        console.log(
          `[cron] Pausing config ${config.id} (${config.domain}) — SE Ranking account binding is ${accountBinding.status}`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          isActive: false,
          lastSkipReason: `SE Ranking account ${accountBinding.status}`,
        });
        continue;
      }

      const projectBinding =
        await SeRankingBindingRepository.getProjectBindingByLocalProject(
          config.projectId,
        );
      if (
        projectBinding &&
        (projectBinding.status === "migration_required" ||
          projectBinding.status === "paused" ||
          projectBinding.status === "failed")
      ) {
        console.log(
          `[cron] Pausing config ${config.id} (${config.domain}) — SE Ranking project binding is ${projectBinding.status}`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          isActive: false,
          lastSkipReason: `SE Ranking project binding is ${projectBinding.status}`,
        });
        continue;
      }

      // 7. Pair-Level Quota & Budget limit guards (Organization & Project)
      const allTargets = await RankTrackingTargetRepository.getTargetsForConfig(
        config.id,
        true,
      );
      const targets = isPilotConfig
        ? allTargets.filter((t) =>
            (APPROVED_PILOT_TARGET_IDS as readonly string[]).includes(t.id),
          )
        : allTargets;

      const targetCount =
        targets.length > 0 ? targets.length : config.devices === "both" ? 2 : 1;
      const estimatedPairs = kwCount * targetCount;
      console.log(
        `[cron] Estimated quota: ${kwCount} keywords x ${targetCount} targets = ${estimatedPairs} target pairs for config ${config.id} (${config.domain})`,
      );

      const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 3600 * 1000,
      ).toISOString();

      const [
        dailyRuns,
        monthlyOrgRuns,
        monthlyProjRuns,
        persistedDailyPairs,
        persistedMonthlyOrgPairs,
        persistedMonthlyProjPairs,
        inFlightOrgPairs,
        inFlightProjPairs,
      ] = await Promise.all([
        RankTrackingRepository.countRunsForOrgSince(
          config.organizationId,
          oneDayAgo,
        ),
        RankTrackingRepository.countRunsForOrgSince(
          config.organizationId,
          thirtyDaysAgo,
        ),
        RankTrackingRepository.countRunsForProjectSince(
          config.projectId,
          thirtyDaysAgo,
        ),
        RankTrackingRepository.countPersistedPairsForOrgSince(
          config.organizationId,
          oneDayAgo,
        ),
        RankTrackingRepository.countPersistedPairsForOrgSince(
          config.organizationId,
          thirtyDaysAgo,
        ),
        RankTrackingRepository.countPersistedPairsForProjectSince(
          config.projectId,
          thirtyDaysAgo,
        ),
        RankTrackingRepository.countInFlightReservedPairsForOrg(
          config.organizationId,
        ),
        RankTrackingRepository.countInFlightReservedPairsForProject(
          config.projectId,
        ),
      ]);

      // Check run-based caps
      if (dailyRuns >= dailyOrgCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — organization daily check cap reached (${dailyRuns}/${dailyOrgCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Organization daily check cap reached (${dailyRuns}/${dailyOrgCap})`,
        });
        continue;
      }

      if (monthlyOrgRuns >= monthlyOrgCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — organization monthly check cap reached (${monthlyOrgRuns}/${monthlyOrgCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Organization monthly check cap reached (${monthlyOrgRuns}/${monthlyOrgCap})`,
        });
        continue;
      }

      if (monthlyProjRuns >= monthlyProjectCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — project monthly check budget reached (${monthlyProjRuns}/${monthlyProjectCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Project monthly check budget reached (${monthlyProjRuns}/${monthlyProjectCap})`,
        });
        continue;
      }

      // Check pair-level caps (factoring in active in-flight reservations)
      const totalDailyOrgPairs = persistedDailyPairs + inFlightOrgPairs;
      const totalMonthlyOrgPairs = persistedMonthlyOrgPairs + inFlightOrgPairs;
      const totalMonthlyProjPairs =
        persistedMonthlyProjPairs + inFlightProjPairs;

      if (totalDailyOrgPairs + estimatedPairs > dailyOrgPairCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — organization daily pair cap reached (${totalDailyOrgPairs} + ${estimatedPairs} > ${dailyOrgPairCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Organization daily pair cap reached (${totalDailyOrgPairs}/${dailyOrgPairCap})`,
        });
        continue;
      }

      if (totalMonthlyOrgPairs + estimatedPairs > monthlyOrgPairCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — organization monthly pair cap reached (${totalMonthlyOrgPairs} + ${estimatedPairs} > ${monthlyOrgPairCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Organization monthly pair cap reached (${totalMonthlyOrgPairs}/${monthlyOrgPairCap})`,
        });
        continue;
      }

      if (totalMonthlyProjPairs + estimatedPairs > monthlyProjectPairCap) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — project monthly pair budget reached (${totalMonthlyProjPairs} + ${estimatedPairs} > ${monthlyProjectPairCap})`,
        );
        await RankTrackingRepository.updateConfig(config.id, config.projectId, {
          lastSkipReason: `Project monthly pair budget reached (${totalMonthlyProjPairs}/${monthlyProjectPairCap})`,
        });
        continue;
      }

      // 8. Begin scheduled rank check run in read-only sync mode (0 recheck POSTs).
      // The partial unique index on rank_check_runs enforces single-flight
      // uniqueness across overlapping cron ticks; only advance nextCheckAt once
      // the scheduled run slot is acquired so an in-flight manual run cannot
      // postpone the weekly schedule.
      const result = await beginRankCheckRun({
        workflow: env.RANK_CHECK_WORKFLOW,
        config,
        projectId: config.projectId,
        billingCustomer: {
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        keywordsTotal: kwCount,
        keywordIds: pilotKeywordIds,
        trigger: "scheduled",
        workflowStartErrorMessage: "Failed to start scheduled workflow",
        readOnlySync: true,
      });

      if (!result.ok) {
        console.log(
          `[cron] Skipping config ${config.id} (${config.domain}) — run already active`,
        );
      } else {
        const interval = isScheduledRankTrackingInterval(
          config.scheduleInterval,
        )
          ? config.scheduleInterval
          : null;
        let newNextCheckAt: string | undefined;
        if (interval) {
          newNextCheckAt = computeNextCheckAt(interval, config.nextCheckAt, {
            minEligibleMs: weeklyMinEligibleMs,
          });
          await RankTrackingRepository.updateConfig(
            config.id,
            config.projectId,
            {
              nextCheckAt: newNextCheckAt,
            },
          );
        }
        console.log(
          `[cron] Started scheduled rank check ${result.runId} for config ${config.id} (${config.domain}). Next check scheduled for: ${newNextCheckAt ?? "none"}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error processing config ${config.id} (${config.domain}):`,
        err,
      );
    }
  }
}
