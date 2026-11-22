import { parsePositiveIntEnv, samStepToolChoice } from "./samTurnControls";

export type SamTask = "lookup" | "standard" | "comprehensive" | "investigation";
export type SamGenerationStage =
  | "gather"
  | "analyze"
  | "synthesize"
  | "recover";
export type SamReasoningEffort = "low" | "high" | "max";
export type SamGenerationDecision = {
  task: SamTask;
  stage: SamGenerationStage;
  effort?: SamReasoningEffort;
  target: number;
};

export const SAM_FALLBACK_OUTPUT = 6000;
export const SAM_BUDGET_EXHAUSTED =
  "SAM reached its generation budget. Ask SAM to continue from the available results.";
export const SAM_BUDGET_REJECTED =
  "The provider rejected SAM's output budget. Ask SAM to continue with a shorter answer.";
export const SAM_GENERATION_TIMEOUT =
  "SAM's generation timed out. Ask SAM to continue from the available results.";
// Keep application ceilings separate from the published model context window.
const GLM_CONTEXT = 1_000_000;
export const SAM_OUTPUT_TARGETS = {
  lookup: 4096,
  standard: 8192,
  comprehensive: 16384,
  investigation: 32768,
} satisfies Record<SamTask, number>;

export function samGenerationLimits(read: (key: string) => string | undefined) {
  const value = (key: string, fallback: number) =>
    parsePositiveIntEnv(read(key), fallback);
  const recovery = read("AI_AGENT_MAX_RECOVERY_ATTEMPTS");
  return {
    maxRecoveryAttempts:
      recovery === "0"
        ? 0
        : Math.min(2, value("AI_AGENT_MAX_RECOVERY_ATTEMPTS", 1)),
    maxTurnInput: value("AI_AGENT_MAX_TURN_INPUT_TOKENS", 524_288),
    maxTurnOutput: value("AI_AGENT_MAX_TURN_OUTPUT_TOKENS", 65_536),
    maxTurnMs: value("AI_AGENT_MAX_TURN_MS", 240_000),
    maxGlmOutput: Math.min(
      32_768,
      value("AI_AGENT_GLM53_MAX_OUTPUT_TOKENS", 16_384),
    ),
  };
}

export function samGenerationCapability(
  provider: string,
  model: string | null,
  glmOutputCap: number,
) {
  const glm =
    provider === "ollama_cloud" &&
    /^glm-5\.3(?::(?:cloud|latest))?$/i.test(model ?? "");
  return {
    glm,
    outputCap: glm ? glmOutputCap : SAM_FALLBACK_OUTPUT,
    context: glm ? GLM_CONTEXT : undefined,
  };
}

function needsTargetedEvidence(text: string): boolean {
  return /\b(?:compare|breakdown|segment|country|device|competitor|page-by-page|technical|last \d+|since|between|mobile|desktop)\b|قارن|مقارن|حسب|تفصيل|دولة|جهاز|منافس|تقني|آخر\s+\d|منذ/iu.test(
    text,
  );
}

export function classifySamTask(request: string): SamTask {
  const text = request.normalize("NFKC").trim();
  const words = text.split(/\s+/u).length;
  const sections = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gmu) ?? []).length;
  const sources = [
    /search console|\bgsc\b|كونسول/u,
    /rank track|rankings?|الترتيب|تصنيف/u,
    /(?:site|technical) audit|تدقيق|تقني/u,
    /competitor|منافس/u,
    /backlink|روابط خلفية/u,
    /analytics|تحليلات/u,
  ].filter((pattern) => pattern.test(text.toLowerCase())).length;
  const analysis =
    /analy[sz]|diagnos|strategy|audit|compar|حلّل|حلل|تحليل|استراتيج|تدقيق|تشخيص|قارن/iu.test(
      text,
    );
  const deliverable =
    /recommend|prioriti|roadmap|action plan|خطة|توصي|أولو/iu.test(text);
  const report = /table|report|breakdown|جدول|تقرير/iu.test(text);
  const exceptional =
    /root cause|multi.stage|investigat|سبب جذري|تحقيق|متعدد المراحل/iu.test(
      text,
    );
  if (
    analysis &&
    (sources >= 4 ||
      (exceptional && (sources >= 2 || sections >= 3 || words >= 80)))
  ) {
    return "investigation";
  }
  if (
    analysis &&
    (sources >= 2 ||
      (deliverable && report) ||
      sections >= 3 ||
      words >= 75 ||
      /competitor|technical|منافس|تقني/iu.test(text))
  ) {
    return "comprehensive";
  }
  if (
    !analysis &&
    !deliverable &&
    !needsTargetedEvidence(text) &&
    sections === 0 &&
    sources <= 1 &&
    words <= 30 &&
    /keyword|rank|search console|كلم|ترتيب|كونسول/iu.test(text)
  ) {
    return "lookup";
  }
  return "standard";
}

export function samGenerationDecision(input: {
  task: SamTask;
  stage: SamGenerationStage;
  glm: boolean;
  preferredEffort?: SamReasoningEffort;
}): SamGenerationDecision {
  const { task, stage } = input;
  const final = stage === "synthesize" || stage === "recover";
  const effort = final
    ? "low"
    : (input.preferredEffort ??
      (task === "investigation"
        ? "max"
        : task === "comprehensive"
          ? "high"
          : "low"));
  return {
    task,
    stage,
    effort: input.glm ? effort : undefined,
    target: input.glm
      ? final
        ? Math.min(SAM_OUTPUT_TARGETS[task], 8192)
        : SAM_OUTPUT_TARGETS[task]
      : SAM_FALLBACK_OUTPUT,
  };
}

export function samBroadKeywordReport(text: string): boolean {
  // Explicit dates, breakdowns and comparisons can need their own queries.
  return (
    /keyword|كلم/iu.test(text) &&
    /performance|أداء/iu.test(text) &&
    !needsTargetedEvidence(text)
  );
}

function haveKeywordReportEvidence(output: unknown): boolean {
  if (
    !output ||
    typeof output !== "object" ||
    !("recommendations" in output) ||
    !Array.isArray(output.recommendations) ||
    output.recommendations.length === 0 ||
    !("sourceAvailability" in output) ||
    !Array.isArray(output.sourceAvailability)
  )
    return false;
  const sources = output.sourceAvailability;
  return ["rank_tracking", "search_console"].every((name) =>
    sources.some(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        "source" in entry &&
        entry.source === name &&
        "status" in entry &&
        entry.status === "available",
    ),
  );
}

function haveLookupEvidence(toolName: string, output: unknown): boolean {
  if (!output || typeof output !== "object" || !("data" in output))
    return false;
  const data = output.data;
  if (!data || typeof data !== "object") return false;
  if (toolName === "get_rank_tracker") {
    if ("targetResults" in data && Array.isArray(data.targetResults))
      return data.targetResults.length > 0;
    const results = "results" in data ? data.results : undefined;
    return Boolean(
      results &&
      typeof results === "object" &&
      "rows" in results &&
      Array.isArray(results.rows) &&
      results.rows.length > 0,
    );
  }
  return (
    toolName === "get_search_console_performance" &&
    "rows" in data &&
    Array.isArray(data.rows) &&
    data.rows.length > 0
  );
}

export function samGenerationStep(
  ctx: {
    stepNumber: number;
    steps: {
      toolCalls: unknown[];
      toolResults: { toolName: string; output?: unknown }[];
    }[];
  },
  limits: { maxSteps: number; maxToolCalls: number },
  task: SamTask,
  remainingOutput: number,
  broadKeywordReport = false,
) {
  const results = ctx.steps.flatMap((step) => step.toolResults);
  const usableLookup =
    task === "lookup" &&
    results.some(({ toolName, output }) =>
      haveLookupEvidence(toolName, output),
    );
  const completeKeywordReport =
    broadKeywordReport &&
    results.some(
      ({ toolName, output }) =>
        toolName === "analyze_seo_project" && haveKeywordReportEvidence(output),
    );
  const reserved =
    samStepToolChoice(ctx, limits) ??
    (remainingOutput <= 8192 || usableLookup || completeKeywordReport
      ? { activeTools: [], toolChoice: "none" as const }
      : undefined);
  const stage = reserved ? "synthesize" : results.length ? "analyze" : "gather";
  return { reserved, stage } as const;
}
