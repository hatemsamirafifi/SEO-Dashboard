import { z } from "zod";
import { reportTypeSchema } from "@/shared/reports";

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const generateReportSchema = z
  .object({
    projectId: z.string().min(1),
    type: reportTypeSchema,
    period: z
      .object({ from: isoDateSchema, to: isoDateSchema })
      .strict()
      .refine((period) => period.from <= period.to, {
        message: "Report period must satisfy from ≤ to",
      }),
    strict: z.boolean().optional(),
  })
  .strict();

export const reportByIdSchema = z
  .object({ projectId: z.string().min(1), id: z.string().min(1) })
  .strict();

export const listReportsSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
