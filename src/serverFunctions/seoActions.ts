import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { SeoActionRepository } from "@/server/features/sam/actions/SeoActionRepository";
import { SeoActionService } from "@/server/features/sam/actions/SeoActionService";
import { SeoActionVerificationEngine } from "@/server/features/sam/actions/seoActionVerification";
import { collectProjectSeoEvidence } from "@/server/features/sam/analyst/seoEvidenceCollector";
import { runSeoAnalysis } from "@/server/features/sam/analyst/seoAnalyzer";
import { buildPrioritizedActionPlan } from "@/server/features/sam/analyst/seoRecommendations";
import {
  SeoActionStatusSchema,
  SeoRecommendationSchema,
  type SeoActionStatus,
  type SeoVerificationOutcome,
} from "@/shared/samSeoAnalyst";

const projectIdSchema = z.object({ projectId: z.string().min(1) });

export const listSeoActionPlans = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(projectIdSchema)
  .handler(async ({ context }) => {
    return SeoActionRepository.getPlansForProject(
      context.projectId,
      context.organizationId,
    );
  });

export const getSeoActionPlan = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      planId: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    let planId = data.planId;
    if (!planId) {
      const plans = await SeoActionRepository.getPlansForProject(
        context.projectId,
        context.organizationId,
      );
      planId = plans[0]?.id;
    }
    if (!planId) {
      return { plan: null, items: [] };
    }
    const plan = await SeoActionRepository.getPlanById(
      planId,
      context.projectId,
      context.organizationId,
    );
    const items = await SeoActionRepository.getItemsForPlan(
      planId,
      context.projectId,
      context.organizationId,
    );
    return { plan, items };
  });

export const listSeoActionItems = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      status: SeoActionStatusSchema.optional(),
      category: z.string().optional(),
      priority: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    return SeoActionRepository.getItemsForProject(
      context.projectId,
      context.organizationId,
      {
        status: data.status,
        category: data.category,
        priority: data.priority,
      },
    );
  });

/**
 * Generates an evidence-based SEO action plan strictly from existing local data.
 * Never persists items automatically — requires explicit user selection and save.
 */
export const generateSeoActionPlan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectIdSchema)
  .handler(async ({ context }) => {
    const evidence = await collectProjectSeoEvidence({
      projectId: context.projectId,
      organizationId: context.organizationId,
      focus: "action_plan",
    });
    const findings = runSeoAnalysis(evidence);
    const existingItems = await SeoActionRepository.getItemsForProject(
      context.projectId,
      context.organizationId,
    );
    const existingRefs = existingItems.map((item) => ({
      id: item.id,
      recommendationFingerprint: item.recommendationFingerprint,
      status: item.status as SeoActionStatus,
      actionPlanId: item.actionPlanId,
      baselineValue: item.baselineValue,
      verificationOutcome:
        (item.verificationOutcome as SeoVerificationOutcome | null) ?? null,
    }));
    const plan = buildPrioritizedActionPlan(evidence, findings, existingRefs);
    return {
      analyzedAt: plan.analyzedAt,
      sourceAvailability: plan.sourceAvailability,
      recommendations: plan.recommendations,
      limitations: plan.limitations,
      missingInformation: plan.missingInformation,
    };
  });

function mapRecToSaveInput(
  rec: z.infer<typeof SeoRecommendationSchema>,
  context: { organizationId: string; projectId: string; userId: string },
  actionPlanId?: string,
  notes?: string,
) {
  return {
    actionPlanId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    recommendationFingerprint: rec.fingerprint || rec.id,
    title: rec.title,
    description: rec.explanation,
    category: rec.category,
    priority: rec.priority,
    effort: rec.implementationEffort,
    expectedImpact: rec.expectedImpact,
    evidenceConfidence: `${rec.confidence.level} (${rec.confidence.score}%)`,
    targetKeyword: rec.targetKeywords[0] ?? null,
    targetUrl: rec.targetUrls[0] ?? null,
    recommendedAction: rec.recommendedAction,
    validationMetric: rec.validationMetric,
    baselineValue: rec.baselineMeasurement ?? null,
    baselineObservationDate: rec.evidenceReferences[0]?.observationDate ?? null,
    dueDate: null,
    status: "proposed" as const,
    evidence: rec.evidenceReferences.map((ref) => ({
      source: ref.sourceTool,
      provider: ref.provider,
      sourceRecordId: ref.sourceRecordId ?? null,
      metricName: ref.metricName,
      metricValue: ref.metricValue,
      observationDate: ref.observationDate ?? null,
    })),
    actor: context.userId,
    notes: notes ?? "Saved from SAM SEO recommendations",
  };
}

async function resolveVerifiedPlanId(
  actionPlanId: string | undefined,
  projectId: string,
  organizationId: string,
): Promise<string | undefined> {
  if (!actionPlanId) return undefined;
  const plan = await SeoActionRepository.getPlanById(
    actionPlanId,
    projectId,
    organizationId,
  );
  if (!plan) {
    throw new Error("Action plan not found or unauthorized");
  }
  return plan.id;
}

export const saveSeoRecommendation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      recommendation: SeoRecommendationSchema,
      actionPlanId: z.string().optional(),
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const planId = await resolveVerifiedPlanId(
      data.actionPlanId,
      context.projectId,
      context.organizationId,
    );
    return SeoActionService.saveRecommendation(
      mapRecToSaveInput(data.recommendation, context, planId, data.notes),
    );
  });

export const saveSeoRecommendationsBatch = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      recommendations: z.array(SeoRecommendationSchema).min(1),
      actionPlanId: z.string().optional(),
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const planId = await resolveVerifiedPlanId(
      data.actionPlanId,
      context.projectId,
      context.organizationId,
    );
    const saved = [];
    for (const rec of data.recommendations) {
      const res = await SeoActionService.saveRecommendation(
        mapRecToSaveInput(rec, context, planId, data.notes),
      );
      saved.push(res);
    }
    return saved;
  });

export const transitionSeoActionStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      itemId: z.string(),
      targetStatus: SeoActionStatusSchema,
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    return SeoActionService.transitionStatus({
      itemId: data.itemId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      targetStatus: data.targetStatus,
      actor: context.userId,
      notes: data.notes ?? null,
    });
  });

export const addSeoActionNote = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      itemId: z.string(),
      notes: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }) => {
    return SeoActionService.addNote({
      itemId: data.itemId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      actor: context.userId,
      notes: data.notes,
    });
  });

export const verifySeoActionItem = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      itemId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return SeoActionVerificationEngine.verifyItem({
      itemId: data.itemId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      actor: context.userId,
    });
  });

export const getSeoActionEvents = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      itemId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const item = await SeoActionRepository.getItemById(
      data.itemId,
      context.projectId,
      context.organizationId,
    );
    if (!item) {
      throw new Error("Item not found");
    }
    return SeoActionRepository.getEventsForItem(data.itemId);
  });

export const getSeoActionEvidence = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      itemId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const item = await SeoActionRepository.getItemById(
      data.itemId,
      context.projectId,
      context.organizationId,
    );
    if (!item) {
      throw new Error("Item not found");
    }
    return SeoActionRepository.getEvidenceForItem(data.itemId);
  });
