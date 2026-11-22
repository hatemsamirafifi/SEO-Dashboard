import { describe, expect, it } from "vitest";
import {
  classifySamTask,
  samBroadKeywordReport,
  samGenerationCapability,
  samGenerationDecision,
  samGenerationLimits,
  samGenerationStep,
} from "./samGenerationPolicy";

const extremeOverrides = (key: string) =>
  ({
    AI_AGENT_MAX_RECOVERY_ATTEMPTS: "99",
    AI_AGENT_GLM53_MAX_OUTPUT_TOKENS: "99999",
  })[key];

describe("SAM generation policy", () => {
  it.each([
    [
      "Give me a brief summary of current keyword rankings in Rank Tracker.",
      "lookup",
    ],
    ["Summarize Search Console clicks", "lookup"],
    ["Show Search Console clicks by device for the last 90 days", "standard"],
    ["Give me next steps for the website", "standard"],
    [
      "Analyze keyword performance and write a table with an action plan",
      "comprehensive",
    ],
    [
      "حلّل أداء الكلمات المفتاحية لموقع sports-ms.com، وقدّم خطة تحسين SEO بالعربية تتضمن جدولًا بالكلمات المفتاحية ومتوسط الترتيب والتوصيات، مع الإبقاء على المصطلحات الإنجليزية مثل CTR وSearch Console.",
      "comprehensive",
    ],
    [
      "Investigate the root cause of a drop by comparing Search Console, rank tracking, and technical audit evidence.",
      "investigation",
    ],
    ["What does the term strategy mean?", "standard"],
  ])("classifies %s as %s", (prompt, task) => {
    expect(classifySamTask(prompt)).toBe(task);
  });

  it("separates the provider capability, stage, and optional preferred effort", () => {
    expect(
      samGenerationCapability("ollama_cloud", "glm-5.3:cloud", 16_384),
    ).toEqual({ glm: true, outputCap: 16_384, context: 1_000_000 });
    expect(
      samGenerationCapability("openai_compatible", "glm-5.3", 16_384),
    ).toEqual({ glm: false, outputCap: 6000, context: undefined });
    expect(
      samGenerationCapability("ollama_cloud", "glm-5.3-flash", 16_384).glm,
    ).toBe(false);
    expect(
      samGenerationDecision({
        task: "investigation",
        stage: "analyze",
        glm: true,
      }),
    ).toMatchObject({ target: 32_768, effort: "max" });
    expect(
      samGenerationDecision({
        task: "comprehensive",
        stage: "analyze",
        glm: true,
      }),
    ).toMatchObject({ target: 16_384, effort: "high" });
    expect(
      samGenerationDecision({ task: "standard", stage: "gather", glm: true }),
    ).toMatchObject({ target: 8192, effort: "low" });
    expect(
      samGenerationDecision({
        task: "standard",
        stage: "gather",
        glm: true,
        preferredEffort: "high",
      }).effort,
    ).toBe("high");
    expect(
      samGenerationDecision({
        task: "investigation",
        stage: "recover",
        glm: true,
        preferredEffort: "max",
      }),
    ).toMatchObject({ target: 8192, effort: "low" });
    expect(
      samGenerationDecision({
        task: "comprehensive",
        stage: "analyze",
        glm: false,
      }).effort,
    ).toBeUndefined();
  });

  it("bounds overrides and reserves a text step when the evidence or budget is ready", () => {
    expect(samGenerationLimits(extremeOverrides)).toMatchObject({
      maxRecoveryAttempts: 2,
      maxGlmOutput: 32768,
    });
    expect(samGenerationLimits(() => "0").maxRecoveryAttempts).toBe(0);
    const limits = { maxSteps: 4, maxToolCalls: 3 };
    const afterLookup = {
      stepNumber: 1,
      steps: [
        {
          toolCalls: [{}],
          toolResults: [
            {
              toolName: "get_rank_tracker",
              output: { data: { results: { rows: [{ position: 5 }] } } },
            },
          ],
        },
      ],
    };
    expect(samGenerationStep(afterLookup, limits, "lookup", 60_000)).toEqual({
      reserved: { activeTools: [], toolChoice: "none" },
      stage: "synthesize",
    });
    expect(
      samGenerationStep(afterLookup, limits, "comprehensive", 60_000).stage,
    ).toBe("analyze");
    expect(
      samGenerationStep(afterLookup, limits, "comprehensive", 8192).stage,
    ).toBe("synthesize");
  });

  it("keeps gathering when Rank Tracker returns only configurations", () => {
    const step = {
      stepNumber: 1,
      steps: [
        {
          toolCalls: [{}],
          toolResults: [
            {
              toolName: "get_rank_tracker",
              output: { data: { configs: [{ id: "tracker" }] } },
            },
          ],
        },
      ],
    };
    expect(
      samGenerationStep(
        step,
        { maxSteps: 10, maxToolCalls: 5 },
        "lookup",
        45_000,
      ).stage,
    ).toBe("analyze");
  });

  it("uses comprehensive evidence only for a broad keyword report", () => {
    expect(
      samBroadKeywordReport("حلّل أداء الكلمات المفتاحية وأعطني جدولًا"),
    ).toBe(true);
    expect(
      samBroadKeywordReport(
        "Analyze keyword performance by country and device",
      ),
    ).toBe(false);
    expect(
      samBroadKeywordReport("حلّل أداء الكلمات المفتاحية حسب الدولة"),
    ).toBe(false);
    const limits = { maxSteps: 5, maxToolCalls: 12 };
    const steps = [
      {
        toolCalls: [{}],
        toolResults: [
          {
            toolName: "analyze_seo_project",
            output: {
              recommendations: [{ title: "Improve a result" }],
              sourceAvailability: [
                { source: "rank_tracking", status: "available" },
                { source: "search_console", status: "available" },
              ],
            },
          },
        ],
      },
    ];
    expect(
      samGenerationStep(
        { stepNumber: 1, steps },
        limits,
        "comprehensive",
        60_000,
        true,
      ).stage,
    ).toBe("synthesize");
    expect(
      samGenerationStep(
        { stepNumber: 1, steps },
        limits,
        "comprehensive",
        60_000,
        false,
      ).stage,
    ).toBe("analyze");
    steps[0].toolResults[0].output.sourceAvailability[1].status = "unavailable";
    expect(
      samGenerationStep(
        { stepNumber: 1, steps },
        limits,
        "comprehensive",
        60_000,
        true,
      ).stage,
    ).toBe("analyze");
  });
});
