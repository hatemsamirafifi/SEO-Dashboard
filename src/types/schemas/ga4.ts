import { z } from "zod";

export const ga4ProjectSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
export const setGa4PropertySchema = ga4ProjectSchema
  .extend({
    accountId: z.string().min(1),
    propertyId: z.string().min(1),
  })
  .strict();
export const startGa4LinkSchema = z
  .object({ projectId: z.string().min(1), callbackURL: z.string().min(1) })
  .strict();

const ga4DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const triggerGa4SyncSchema = ga4ProjectSchema
  .extend({
    syncType: z.enum(["initial", "incremental", "manual"]).default("manual"),
    startDate: ga4DateSchema.optional(),
    endDate: ga4DateSchema.optional(),
  })
  .strict();
export const ga4SyncStatusSchema = ga4ProjectSchema;
export const ga4PeriodUsersSchema = ga4ProjectSchema
  .extend({ startDate: ga4DateSchema, endDate: ga4DateSchema })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must not be after endDate",
  });
