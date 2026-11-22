import type { SamToolTraceEvent } from "@/shared/samToolTraceTypes";

function sumUsage(events: SamToolTraceEvent[], key: string): string {
  let total = 0;
  let count = 0;
  for (const event of events) {
    const value = event.metadata?.[key];
    if (typeof value !== "number") continue;
    total += value;
    count += 1;
  }
  if (!count) return "Unavailable";
  return total.toLocaleString() + (count < events.length ? " (partial)" : "");
}

function display(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string" && value) return value;
  return "Unavailable";
}

export function SamGenerationTrace({
  events,
}: {
  events: SamToolTraceEvent[];
}) {
  const requests = events.filter(({ event }) => event === "generation_request");
  if (!requests.length) return null;
  const first = requests[0].metadata;
  const current = requests.at(-1)?.metadata;
  const finishes = events.filter(({ event }) => event === "generation_finish");
  const terminal = events.findLast(
    ({ event }) => event === "generation_terminal",
  )?.metadata;
  // Missing usage on an in-flight, rejected, aborted or failed request stays
  // visible as unavailable/partial rather than being counted as zero.
  const measured = finishes.filter(
    ({ metadata }) => metadata?.finishReason !== "budget-rejected",
  );
  const incompleteUsage =
    measured.length <
    requests.length -
      finishes.filter(
        ({ metadata }) => metadata?.finishReason === "budget-rejected",
      ).length;
  const usageRows = [
    ["Input tokens", "inputTokens"],
    ["Output tokens", "outputTokens"],
    ["Reasoning tokens", "reasoningTokens"],
  ].map(([label, key]) => {
    const value = sumUsage(measured, key);
    return [
      label,
      incompleteUsage &&
      value !== "Unavailable" &&
      !value.endsWith(" (partial)")
        ? value + " (partial)"
        : value,
    ];
  });
  const status = terminal?.status;
  const rows = [
    ["Task", display(first?.task)],
    [
      "Stages and effort",
      requests
        .map(({ metadata }) =>
          [display(metadata?.stage), display(metadata?.effort)].join(" / "),
        )
        .filter((value, i, list) => i === 0 || value !== list[i - 1])
        .join(" → "),
    ],
    ["Output budget requested", display(current?.requested)],
    ["Policy target", display(current?.target)],
    ["Provider effective output cap", "Unavailable"],
    ...usageRows,
    ["Finish reason", display(finishes.at(-1)?.metadata?.finishReason)],
    [
      "Model steps / tool calls",
      display(terminal?.modelSteps) + " / " + display(terminal?.toolCalls),
    ],
    [
      "Recovery attempts",
      display(terminal?.recoveryAttempts ?? current?.recoveryAttempts),
    ],
    [
      "Answer",
      status === "completed"
        ? "Complete"
        : status === "aborted"
          ? "Interrupted"
          : status === "paused"
            ? "Waiting for approval"
            : status
              ? "Incomplete"
              : "In progress",
    ],
  ];

  return (
    <details className="border-b border-base-300 px-3 py-1.5 text-[11px]">
      <summary className="cursor-pointer font-medium">Generation</summary>
      <dl className="mt-1 grid grid-cols-[1fr_1.1fr] gap-x-2 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-base-content/65">{label}</dt>
            <dd dir="auto" className="min-w-0 break-words">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
