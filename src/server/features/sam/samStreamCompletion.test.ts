import { stepCountIs, streamText, tool, type UIMessageChunk } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requireSamCompletion } from "./samStreamCompletion";
import { samStepToolChoice } from "./samTurnControls";

const toolResult: UIMessageChunk = {
  type: "tool-output-available",
  toolCallId: "gsc",
  output: { rows: 2 },
};
const text = (delta: string): UIMessageChunk => ({
  type: "text-delta",
  id: "answer",
  delta,
});

async function complete(chunks: UIMessageChunk[], arabic = false) {
  async function* source() {
    yield* chunks;
  }
  const result: unknown[] = [];
  for await (const chunk of requireSamCompletion(source(), arabic)) {
    result.push(chunk);
  }
  return result;
}

describe("SAM stream completion", () => {
  it("reports a provider length limit after successful tools and reasoning", async () => {
    const chunks: UIMessageChunk[] = [
      toolResult,
      { type: "start-step" },
      { type: "reasoning-delta", id: "reason", delta: "Thinking" },
      { type: "finish-step" },
    ];
    const result = await complete([
      ...chunks,
      { type: "finish", finishReason: "length" },
    ]);
    expect(result).toEqual([
      ...chunks,
      {
        type: "error",
        errorText: expect.stringMatching(/output limit.*continue/),
      },
    ]);
  });

  it("preserves partial text on a truncated response", async () => {
    const partial = text("النتائج المتاحة");
    const result = await complete(
      [toolResult, partial, { type: "finish", finishReason: "length" }],
      true,
    );
    expect(result).toEqual([
      toolResult,
      partial,
      { type: "error", errorText: expect.stringContaining("حدّ الإخراج") },
    ]);
  });

  it("accepts a visible answer generated after tool results", async () => {
    const chunks: UIMessageChunk[] = [
      toolResult,
      { type: "start-step" },
      text("متوسط الترتيب في Search Console"),
      { type: "finish-step" },
      { type: "finish", finishReason: "stop" },
    ];
    expect(await complete(chunks)).toEqual(chunks);
  });

  it("reports exhausted tools and a stop without an answer", async () => {
    expect(
      await complete([
        toolResult,
        { type: "finish", finishReason: "tool-calls" },
      ]),
    ).toEqual([
      toolResult,
      { type: "error", errorText: expect.stringMatching(/tools.*continue/) },
    ]);
    expect(
      await complete([text("  "), { type: "finish", finishReason: "stop" }]),
    ).toEqual([
      text("  "),
      {
        type: "error",
        errorText: expect.stringContaining("without an answer"),
      },
    ]);
  });

  it("accepts a deliberate pause for tool approval", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "tool-approval-request", approvalId: "ask", toolCallId: "tool" },
      { type: "finish", finishReason: "tool-calls" },
    ];
    expect(await complete(chunks)).toEqual(chunks);
  });

  it("turns a premature end or abort into a recoverable error", async () => {
    for (const chunks of [
      [toolResult],
      [toolResult, { type: "abort" } as const],
    ]) {
      expect(await complete(chunks)).toEqual([
        toolResult,
        {
          type: "error",
          errorText: expect.stringMatching(/interrupted.*continue/),
        },
      ]);
    }
  });

  it("passes an existing normalized provider error through without a second error", async () => {
    const failure = { type: "error", errorText: "Try again shortly." } as const;
    expect(await complete([toolResult, failure])).toEqual([
      toolResult,
      failure,
    ]);
  });

  it.each([
    { maxSteps: 2, maxToolCalls: 24 },
    { maxSteps: 48, maxToolCalls: 1 },
  ])(
    "uses the collected tool result at the configured limit %j",
    async (limits) => {
      const execute = vi.fn(async () => ({ rows: 2 }));
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          const hasTools = Boolean(options.tools?.length);
          const finishReason = hasTools ? "tool-calls" : "stop";
          if (!hasTools) {
            expect(options.prompt).toContainEqual(
              expect.objectContaining({ role: "tool" }),
            );
          }
          return {
            stream: simulateReadableStream({
              chunks: [
                ...(hasTools
                  ? [
                      {
                        type: "tool-call" as const,
                        toolCallId: "gsc",
                        toolName: "search",
                        input: "{}",
                      },
                    ]
                  : [
                      { type: "text-start" as const, id: "answer" },
                      {
                        type: "text-delta" as const,
                        id: "answer",
                        delta: "نتائج Search Console",
                      },
                      { type: "text-end" as const, id: "answer" },
                    ]),
                {
                  type: "finish",
                  finishReason: { unified: finishReason, raw: finishReason },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ],
            }),
          };
        },
      });
      const result = streamText({
        model,
        prompt: "حلّل أداء الكلمات المفتاحية",
        tools: { search: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(limits.maxSteps),
        prepareStep: (ctx) => samStepToolChoice(ctx, limits),
      });
      const chunks: unknown[] = [];
      for await (const chunk of requireSamCompletion(
        result.toUIMessageStream(),
        true,
      )) {
        chunks.push(chunk);
      }
      expect(execute).toHaveBeenCalledOnce();
      expect(model.doStreamCalls).toHaveLength(2);
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: "tool-output-available" }),
      );
      expect(chunks).toContainEqual(text("نتائج Search Console"));
      expect(chunks.at(-1)).toMatchObject({
        type: "finish",
        finishReason: "stop",
      });
    },
  );
});
