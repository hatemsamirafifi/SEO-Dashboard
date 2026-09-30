import { createServerFn } from "@tanstack/react-start";
import { ActivationRepository } from "@/server/features/activation/repositories/ActivationRepository";
import { DashboardService } from "@/server/features/dashboard/services/DashboardService";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { InsightService } from "@/server/features/intelligence/services/InsightService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  dashboardProjectInputSchema,
  dismissInsightSchema,
} from "@/types/schemas/dashboard";

export const getDashboardActivation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(({ context }) =>
    DashboardService.getActivation({
      projectId: context.projectId,
      organizationId: context.organizationId,
      domain: context.project.domain,
    }),
  );

export const getDashboardOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(async ({ context }) => {
    // Legacy overview (rank/audit/backlinks for existing cards and report
    // snapshots) merged additively with the A0 intelligence rollup. The merge
    // re-reads stored summaries; a later package consolidates the two paths.
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
  .handler(({ context }) =>
    DashboardService.ensureBacklinkSnapshot({
      projectId: context.projectId,
      domain: context.project.domain,
      billingCustomer: context,
    }),
  );

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
    const connection = await Ga4ConnectionRepository.getByProjectId(
      context.projectId,
      context.organizationId,
    );
    return InsightService.getDashboardInsights({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      ga4Connected: connection !== null,
    });
  });

export const dismissInsight = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dismissInsightSchema)
  .handler(async ({ context, data }) =>
    InsightService.dismissInsight({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      insightKey: data.insightKey,
      snoozedUntil: data.snoozedUntil,
    }),
  );
