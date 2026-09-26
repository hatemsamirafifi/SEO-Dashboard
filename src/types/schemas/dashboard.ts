import { z } from "zod";

export const dashboardHeroStepSchema = z.enum([
  "domain",
  "mcp",
  "gsc",
  "competitor",
]);
export type DashboardHeroStep = z.infer<typeof dashboardHeroStepSchema>;

export const dashboardProjectInputSchema = z.object({
  projectId: z.string().min(1),
});

export const dismissInsightSchema = z
  .object({
    projectId: z.string().min(1),
    insightKey: z.string().min(1),
    snoozedUntil: z.string().min(1).nullable().optional(),
  })
  .strict();
