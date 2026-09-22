import { z } from "zod";

export const intelligenceProjectSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();

export const triggerIntelligenceScanSchema = intelligenceProjectSchema;
export const intelligenceScanStatusSchema = intelligenceProjectSchema;
