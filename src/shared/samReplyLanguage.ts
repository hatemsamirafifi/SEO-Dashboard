import { z } from "zod";

export const samReplyLanguageSchema = z.enum(["auto", "ar", "en"]);
export type SamReplyLanguage = z.infer<typeof samReplyLanguageSchema>;
