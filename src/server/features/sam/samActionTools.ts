import { tool } from "ai";
import { z } from "zod";
import { withPgClient } from "@/db";
import { SeoActionStatusSchema } from "@/shared/samSeoAnalyst";
import { SeoActionRepository } from "./actions/SeoActionRepository";
import { SeoActionVerificationEngine } from "./actions/seoActionVerification";

export function buildSamActionTools(authContext: {
  projectId: string;
  organizationId: string;
  userId?: string | null;
}) {
  const { projectId, organizationId } = authContext;

  return {
    list_seo_action_plans: tool({
      description:
        "List all persistent SEO action plans for the current project. Read-only, uses no credits.",
      inputSchema: z.object({}),
      execute: async () => {
        return withPgClient(async () => {
          const plans = await SeoActionRepository.getPlansForProject(
            projectId,
            organizationId,
          );
          return { plans };
        });
      },
    }),
    get_seo_action_plan: tool({
      description:
        "Retrieve an SEO action plan and its associated tasks/items by plan id (or primary plan if omitted). Read-only, uses no credits.",
      inputSchema: z.object({
        planId: z
          .string()
          .optional()
          .describe(
            "Action plan ID. If omitted, retrieves primary or first action plan.",
          ),
      }),
      execute: async (args) => {
        return withPgClient(async () => {
          let targetPlanId = args.planId;
          if (!targetPlanId) {
            const plans = await SeoActionRepository.getPlansForProject(
              projectId,
              organizationId,
            );
            targetPlanId = plans[0]?.id;
          }
          if (!targetPlanId) {
            return { plan: null, items: [] };
          }
          const plan = await SeoActionRepository.getPlanById(
            targetPlanId,
            projectId,
            organizationId,
          );
          const items = await SeoActionRepository.getItemsForPlan(
            targetPlanId,
            projectId,
            organizationId,
          );
          return { plan, items };
        });
      },
    }),
    get_seo_action_items: tool({
      description:
        "List persistent SEO action items for the current project with optional status/category filtering. Read-only, uses no credits.",
      inputSchema: z.object({
        status: SeoActionStatusSchema.optional().describe("Filter by task status"),
        category: z
          .string()
          .optional()
          .describe("Filter by recommendation category"),
        priority: z.string().optional().describe("Filter by priority"),
      }),
      execute: async (args) => {
        return withPgClient(async () => {
          const items = await SeoActionRepository.getItemsForProject(
            projectId,
            organizationId,
            {
              status: args.status,
              category: args.category,
              priority: args.priority,
            },
          );
          return { items };
        });
      },
    }),
    verify_seo_action_progress: tool({
      description:
        "Inspect local OpenSEO evidence to evaluate the progress of an SEO action item. Strictly read-only: uses no external credits and never modifies task workflow status (recording verification requires explicit user action in the Action Plans UI).",
      inputSchema: z.object({
        itemId: z.string().describe("The action item ID to evaluate."),
      }),
      execute: async (args) => {
        return withPgClient(async () => {
          return SeoActionVerificationEngine.evaluateItem({
            itemId: args.itemId,
            projectId,
            organizationId,
          });
        });
      },
    }),
  };
}
