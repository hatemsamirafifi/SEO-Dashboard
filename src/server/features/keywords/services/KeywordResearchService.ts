import {
  deleteSavedKeywordTag,
  getSavedKeywords,
  getSerpAnalysis,
  removeSavedKeywords,
  research,
  saveKeywords,
  exportSavedKeywords,
  updateSavedKeywordTag,
  updateSavedKeywordTags,
  refreshSavedKeywordMetrics,
} from "@/server/features/keywords/services/research";

export type { SerpAnalysisResult } from "@/server/features/keywords/services/research/serp";

export const KeywordResearchService = {
  research,
  getSerpAnalysis,
  saveKeywords,
  getSavedKeywords,
  exportSavedKeywords,
  updateSavedKeywordTags,
  updateSavedKeywordTag,
  deleteSavedKeywordTag,
  removeSavedKeywords,
  refreshSavedKeywordMetrics,
} as const;
