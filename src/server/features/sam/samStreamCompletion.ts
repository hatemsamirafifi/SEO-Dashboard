import type { UIMessageChunk } from "ai";
import {
  SAM_BUDGET_EXHAUSTED,
  SAM_BUDGET_REJECTED,
  SAM_GENERATION_TIMEOUT,
} from "./samGenerationPolicy";

const generationErrorsArabic = new Map([
  [
    SAM_BUDGET_EXHAUSTED,
    "بلغ سام حدّ التوليد. اطلب منه المتابعة من النتائج المتاحة.",
  ],
  [
    SAM_BUDGET_REJECTED,
    "رفض المزود حدّ الإخراج المطلوب. اطلب من سام المتابعة بإجابة أقصر.",
  ],
  [
    SAM_GENERATION_TIMEOUT,
    "انتهت مهلة رد سام. اطلب منه المتابعة من النتائج المتاحة.",
  ],
]);

const messages = {
  length: [
    "SAM reached the model's output limit. Ask SAM to continue from the results above, or request a shorter answer.",
    "بلغ سام حدّ الإخراج للنموذج. اطلب منه المتابعة من النتائج السابقة أو تقديم إجابة أقصر.",
  ],
  tools: [
    "SAM stopped before it could finish using its tools. Ask SAM to continue from the results above.",
    "توقّف سام قبل إتمام العمل بالأدوات. اطلب منه المتابعة من النتائج السابقة.",
  ],
  empty: [
    "The model ended the request without an answer. Ask SAM to continue from the available results.",
    "أنهى النموذج الطلب دون إجابة. اطلب من سام المتابعة من النتائج المتاحة.",
  ],
  interrupted: [
    "SAM's response was interrupted. Ask SAM to continue from the available results, or try again.",
    "انقطع رد سام. اطلب منه المتابعة من النتائج المتاحة أو أعد المحاولة.",
  ],
};

export async function* requireSamCompletion(
  stream: AsyncIterable<unknown>,
  arabic: boolean,
): AsyncGenerator {
  const error = (reason: keyof typeof messages): UIMessageChunk => ({
    type: "error",
    errorText: messages[reason][arabic ? 1 : 0],
  });
  let hasAnswerText = false;
  let awaitingApproval = false;

  for await (const chunk of stream) {
    if (chunk && typeof chunk === "object" && "type" in chunk) {
      switch (chunk.type) {
        case "start-step":
          hasAnswerText = false;
          awaitingApproval = false;
          break;
        case "text-delta":
          if (
            "delta" in chunk &&
            typeof chunk.delta === "string" &&
            chunk.delta.trim()
          ) {
            hasAnswerText = true;
          }
          break;
        case "tool-approval-request":
          awaitingApproval = true;
          break;
        case "abort":
          if (
            "reason" in chunk &&
            typeof chunk.reason === "string" &&
            /timeout|timed out/i.test(chunk.reason)
          ) {
            yield {
              type: "error",
              errorText: arabic
                ? generationErrorsArabic.get(SAM_GENERATION_TIMEOUT)
                : SAM_GENERATION_TIMEOUT,
            };
          } else {
            yield error("interrupted");
          }
          return;
        case "error": {
          const localized =
            arabic &&
            "errorText" in chunk &&
            typeof chunk.errorText === "string"
              ? generationErrorsArabic.get(chunk.errorText)
              : undefined;
          yield localized ? { type: "error", errorText: localized } : chunk;
          return;
        }
        case "finish": {
          const reason =
            "finishReason" in chunk ? chunk.finishReason : undefined;
          if (reason === "stop" && hasAnswerText) yield chunk;
          else if (reason === "tool-calls" && awaitingApproval) yield chunk;
          else if (reason === "length") yield error("length");
          else if (reason === "tool-calls") yield error("tools");
          else if (reason === "stop") yield error("empty");
          else yield error("interrupted");
          return;
        }
      }
    }
    yield chunk;
  }
  yield error("interrupted");
}
