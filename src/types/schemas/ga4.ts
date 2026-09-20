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
  .object({ callbackURL: z.string().min(1) })
  .strict();
