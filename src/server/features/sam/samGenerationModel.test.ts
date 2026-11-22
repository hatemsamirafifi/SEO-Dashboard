import { stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createSamGeneration,
  type SamGenerationTrace,
} from "./samGenerationModel";
import { samGenerationLimits } from "./samGenerationPolicy";
import { requireSamCompletion } from "./samStreamCompletion";

type ScriptedPart =
  Awaited<
    ReturnType<MockLanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

function finish(reason: "stop" | "length" | "tool-calls"): ScriptedPart {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: {
        total: 200,
        noCache: 200,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 800, text: 200, reasoning: 600 },
      raw: { completion_tokens_details: { reasoning_tokens: 600 } },
    },
  };
}

function answer(text: string): ScriptedPart[] {
  return [
    { type: "text-start", id: "reply" },
    { type: "text-delta", id: "reply", delta: text },
    { type: "text-end", id: "reply" },
  ];
}

function modelFrom(script: (ScriptedPart[] | Error)[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = script[index++];
      if (!parts || parts instanceof Error)
        throw parts ?? new Error("Unexpected call");
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

function setup(
  overrides: Partial<Parameters<typeof createSamGeneration>[0]["limits"]> = {},
  provider = "ollama_cloud",
) {
  const traces: SamGenerationTrace[] = [];
  const billRecovery = vi.fn();
  const generation = createSamGeneration({
    provider,
    model: "glm-5.3",
    task: "comprehensive",
    limits: { ...samGenerationLimits(() => undefined), ...overrides },
    trace: (event) => traces.push(event),
    billRecovery,
  });
  return { generation, traces, billRecovery };
}

async function run(model: LanguageModel) {
  const result = streamText({ model, maxRetries: 0, prompt: "أعطني التقرير" });
  const chunks: unknown[] = [];
  for await (const chunk of requireSamCompletion(
    result.toUIMessageStream({ sendReasoning: false }),
    true,
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("SAM generation middleware", () => {
  it("recovers a reasoning-only length after a real SDK tool round-trip", async () => {
    const { generation, traces, billRecovery } = setup();
    const model = modelFrom([
      [
        {
          type: "tool-call",
          toolCallId: "gsc",
          toolName: "search",
          input: "{}",
        },
        finish("tool-calls"),
      ],
      [
        { type: "reasoning-start", id: "reason" },
        { type: "reasoning-delta", id: "reason", delta: "provider reasoning" },
        { type: "reasoning-end", id: "reason" },
        finish("length"),
      ],
      [
        ...answer("| الكلمة | CTR |\n| --- | --- |\n| مثال | 2% |"),
        finish("stop"),
      ],
    ]);
    const execute = vi.fn(async () => ({ rows: 2 }));
    const result = streamText({
      model,
      maxRetries: 0,
      prompt: "أعطني التقرير",
      tools: { search: tool({ inputSchema: z.object({}), execute }) },
      stopWhen: stepCountIs(3),
      prepareStep: (ctx) => ({
        model: generation.wrap(
          ctx.model,
          ctx.stepNumber ? "analyze" : "gather",
        ),
      }),
    });
    const chunks: unknown[] = [];
    for await (const chunk of requireSamCompletion(
      result.toUIMessageStream({ sendReasoning: false }),
      true,
    )) {
      chunks.push(chunk);
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[2]).toMatchObject({
      toolChoice: { type: "none" },
      maxOutputTokens: 8192,
      providerOptions: { ollamaCloud: { reasoningEffort: "low" } },
    });
    expect(model.doStreamCalls[2].prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining('"rows":2'),
            }),
          ]),
        }),
      ]),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-output-available",
        output: { rows: 2 },
      }),
    );
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
    expect(JSON.stringify(chunks)).not.toContain("provider reasoning");
    expect(
      traces
        .filter((event) => event.event === "generation_finish")
        .map((event) => event.metadata.finishReason),
    ).toEqual(["tool-calls", "length", "stop"]);
    expect(billRecovery).toHaveBeenCalledOnce();
    expect(generation.remainingOutput()).toBe(65_536 - 2400);
  });

  it("preserves partial Markdown and marks it incomplete without repeating it", async () => {
    const { generation } = setup();
    const model = modelFrom([
      [...answer("| الكلمة | CTR |"), finish("length")],
    ]);
    const chunks = await run(generation.wrap(model, "analyze"));
    expect(model.doStreamCalls).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "text-delta",
        delta: "| الكلمة | CTR |",
      }),
    );
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      errorText: expect.stringContaining("حدّ الإخراج"),
    });
  });

  it("exhausts recovery after one retry and blocks tool calls during recovery", async () => {
    const { generation } = setup();
    const model = modelFrom([
      [finish("length")],
      [
        {
          type: "tool-call",
          toolName: "search",
          toolCallId: "unexpected",
          input: "{}",
        },
        finish("length"),
      ],
    ]);
    const result = await run(generation.wrap(model, "gather"));
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("unexpected");
    expect(result.at(-1)).toMatchObject({ type: "error" });
  });

  it("clamps the budget and retries a rejected value once at the verified fallback", async () => {
    const { generation, traces } = setup({ maxGlmOutput: 10_000 });
    const rejected = Object.assign(new Error("max_tokens must be <= 6000"), {
      statusCode: 400,
    });
    const model = modelFrom([
      rejected,
      [...answer("نتائج التحليل"), finish("stop")],
    ]);
    expect((await run(generation.wrap(model, "gather"))).at(-1)).toMatchObject({
      type: "finish",
    });
    expect(
      model.doStreamCalls.map((options) => options.maxOutputTokens),
    ).toEqual([10_000, 6000]);
    expect(
      traces.some((event) => event.metadata.finishReason === "budget-rejected"),
    ).toBe(true);
  });

  it("preserves the conservative default and omits reasoning options for another provider", async () => {
    const { generation } = setup({}, "openai_compatible");
    const model = modelFrom([[...answer("نتائج التحليل"), finish("stop")]]);
    await run(generation.wrap(model, "gather"));
    expect(model.doStreamCalls[0].maxOutputTokens).toBe(6000);
    expect(model.doStreamCalls[0].providerOptions).toBeUndefined();
  });

  it("does not retry a provider error or a cancelled request", async () => {
    const { generation } = setup();
    const failed = modelFrom([
      Object.assign(new Error("Provider unavailable"), { statusCode: 503 }),
    ]);
    expect((await run(generation.wrap(failed, "gather"))).at(-1)).toMatchObject(
      { type: "error" },
    );
    expect(failed.doStreamCalls).toHaveLength(1);

    const cancelled = modelFrom([[finish("length")]]);
    const controller = new AbortController();
    controller.abort();
    const result = streamText({
      model: generation.wrap(cancelled, "gather"),
      prompt: "Stop",
      abortSignal: controller.signal,
    });
    const chunks: unknown[] = [];
    for await (const chunk of requireSamCompletion(
      result.toUIMessageStream(),
      false,
    )) {
      chunks.push(chunk);
    }
    expect(cancelled.doStreamCalls).toHaveLength(0);
    expect(chunks.at(-1)).toMatchObject({ type: "error" });
  });
});
