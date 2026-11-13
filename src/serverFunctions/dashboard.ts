import { createServerFn } from "@tanstack/react-start";
import { ActivationRepository } from "@/server/features/activation/repositories/ActivationRepository";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import {
  InsightRepository,
  type InsightRow,
} from "@/server/features/intelligence/repositories/InsightRepository";
import { ScanLedgerRepository } from "@/server/features/intelligence/repositories/ScanLedgerRepository";
import { requireProjectContext } from "./middleware";
import {
  dashboardProjectInputSchema,
  dismissInsightSchema,
} from "@/types/schemas/dashboard";

const INSIGHT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function parseStringList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function isSnoozed(snoozedUntil: string | null, now: number): boolean {
  if (!snoozedUntil) return false;
  const ms = Date.parse(snoozedUntil);
  return Number.isFinite(ms) && ms > now;
}

export type DashboardInsightView = InsightRow & {
  updatedSinceDismiss: boolean;
  findingKeys: string[];
  opportunityIds: string[];
  entityRefs: string[];
  sources: string[];
};

export type DashboardBanner = {
  skipped: Array<{ detectorKey: string; reason: string | null }>;
  failed: Array<{ detectorKey: string; error: string | null }>;
  lastCompletedAt: string | null;
  hasSuccessfulScan: boolean;
  stale: boolean;
  ga4Connected: boolean;
};

export const getDashboardActivation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    const [gsc, orgActivation, projectActivation] = await Promise.all([
      GscConnectionRepository.getByProjectId(context.projectId),
      ActivationRepository.getOrganizationActivation(context.organizationId),
      ActivationRepository.getProjectActivation(context.projectId),
    ]);

    return {
      domain: context.project.domain,
      gsc: { connected: gsc !== null, siteUrl: gsc?.siteUrl ?? null },
      mcp: {
        authorizedAt: orgActivation?.firstMcpAuthorizedAt ?? null,
        firstToolCallAt: orgActivation?.firstMcpToolCallAt ?? null,
        cardDismissedAt: projectActivation?.mcpCardDismissedAt ?? null,
      },
      competitorClickedAt: projectActivation?.competitorStepClickedAt ?? null,
    };
  });

export const getDashboardOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    const { DashboardService } =
      await import("@/server/features/dashboard/services/DashboardService");
    const [legacy, intelligence] = await Promise.all([
      DashboardService.getOverview({
        projectId: context.projectId,
        domain: context.project.domain,
      }),
      DashboardService.getIntelligenceOverview({
        projectId: context.projectId,
        domain: context.project.domain,
        organizationId: context.organizationId,
        userId: context.userId,
      }),
    ]);
    return { ...legacy, ...intelligence };
  });

// Visit-triggered: the client calls this when the overview reports a missing
// or stale backlink snapshot. Metered against org credits at most once per
// project per day (the service re-checks freshness server-side).
export const refreshDashboardBacklinkSnapshot = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    const { DashboardService } =
      await import("@/server/features/dashboard/services/DashboardService");
    return DashboardService.ensureBacklinkSnapshot({
      projectId: context.projectId,
      domain: context.project.domain,
      billingCustomer: context,
    });
  });

export const markDashboardCompetitorClicked = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    await ActivationRepository.markCompetitorStepClicked(context.projectId);
    return { ok: true as const };
  });

// "I already connected" on the MCP card. Hides the card for this project;
// the org-level milestone stays untouched and self-corrects on the next
// real external tool call.
export const dismissDashboardMcpCard = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    await ActivationRepository.markMcpCardDismissed(context.projectId);
    return { ok: true as const };
  });

/**
 * Composed dashboard insights (final-plan §11): stored rows plus per-user
 * prefs, scan-ledger banners, and the GA4 connect flag. Reads only — scans
 * run on the cron/manual paths, never from dashboard reads.
 */
export const getDashboardInsights = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    const now = Date.now();
    const [connection, rows, prefs, latest, lastSuccess] = await Promise.all([
      Ga4ConnectionRepository.getByProjectId(
        context.projectId,
        context.organizationId,
      ),
      InsightRepository.listVisibleByProject(context.projectId),
      InsightRepository.listPreferencesByProject(
        context.userId,
        context.projectId,
      ),
      ScanLedgerRepository.getLatestRun(context.projectId),
      ScanLedgerRepository.getLatestSuccessfulRun(context.projectId),
    ]);

    const prefByKey = new Map(prefs.map((pref) => [pref.insightKey, pref]));
    const insights: DashboardInsightView[] = [];
    let dismissedCount = 0;

    for (const row of rows) {
      const pref = prefByKey.get(row.insightKey);
      const dismissedVersion = pref?.dismissedContentVersion ?? 0;
      const snoozed = isSnoozed(pref?.snoozedUntil ?? null, now);
      if (dismissedVersion >= row.contentVersion || snoozed) {
        dismissedCount += 1;
        continue;
      }
      insights.push({
        ...row,
        updatedSinceDismiss:
          dismissedVersion > 0 && dismissedVersion < row.contentVersion,
        findingKeys: parseStringList(row.findingKeysJson),
        opportunityIds: parseStringList(row.opportunityIdsJson),
        entityRefs: parseStringList(row.entityRefsJson),
        sources: parseStringList(row.sourcesJson),
      });
    }

    const outcomes = latest
      ? await ScanLedgerRepository.getDetectorOutcomes(latest.id)
      : [];
    const lastCompletedAt = lastSuccess?.completedAt ?? null;

    return {
      insights,
      dismissedCount,
      banner: {
        skipped: outcomes
          .filter((o) => o.status === "skipped")
          .map((o) => ({ detectorKey: o.detectorKey, reason: o.skipReason })),
        failed: outcomes
          .filter((o) => o.status === "failed")
          .map((o) => ({ detectorKey: o.detectorKey, error: o.error })),
        lastCompletedAt,
        hasSuccessfulScan: lastCompletedAt !== null,
        stale:
          !lastCompletedAt ||
          now - Date.parse(lastCompletedAt) > INSIGHT_STALE_AFTER_MS,
        ga4Connected: connection !== null,
      },
    };
  });

export const dismissInsight = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dismissInsightSchema)
  .handler(async ({ context, data }) => {
    const { InsightService } =
      await import("@/server/features/intelligence/services/InsightService");
    return InsightService.dismissInsight({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      insightKey: data.insightKey,
      snoozedUntil: data.snoozedUntil,
    });
  });
