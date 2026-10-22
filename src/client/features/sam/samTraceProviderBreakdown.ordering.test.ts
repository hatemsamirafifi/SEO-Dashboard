import { describe, expect, it } from "vitest";

import type {
  SamToolTraceEvent,
  SamTraceFrame,
} from "@/shared/samToolTraceTypes";
import { reduceTraceFrame, type TraceToolView } from "./samTraceReducer";
import {
  formatProviderBreakdown,
  providerDisplayLabel,
} from "./samTraceFormat";

// Provider-breakdown tests (Phase DT — observability enhancement): the
// breakdown must be derived EXCLUSIVELY from provider_request events, sum
// exactly to providerCalls, and never count cache hits, gate blocks, model
// attempts, or fallback hints. Ordering is deterministic (first-seen).

let seq = 0;
function ev(
  event: SamToolTraceEvent["event"],
  fields: Partial<SamToolTraceEvent> = {},
): SamToolTraceEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    turnId: "turn_pb",
    timestamp: Date.now(),
    sequence: seq,
    event,
    ...fields,
  };
}

function frame(events: SamToolTraceEvent[]): SamTraceFrame {
  return {
    type: "sam_trace",
    events,
    ai: { provider: "Ollama Cloud", model: "kimi-k2.7-code" },
  };
}

function toolOf(view: ReturnType<typeof reduceTraceFrame>): TraceToolView {
  const tool = view.tools[0];
  if (!tool) throw new Error("no tool in view");
  return tool;
}

/** Standard lifecycle prefix for one real handler execution. */
function attemptPrefix(tool: string): SamToolTraceEvent[] {
  return [
    ev("model_attempt", { toolName: tool }),
    ev("gate_allowed", { toolName: tool }),
    ev("handler_start", { toolName: tool, attempt: 1 }),
  ];
}

describe("provider breakdown — ordering, identity, secrecy", () => {
  it("11. deterministic ordering: first-seen execution order, stable", () => {
    const events: SamToolTraceEvent[] = [
      ...attemptPrefix("get_domain_overview"),
      ev("provider_request", {
        toolName: "get_domain_overview",
        provider: "dataforseo",
      }),
      ev("provider_error", {
        toolName: "get_domain_overview",
        provider: "dataforseo",
      }),
      ev("provider_request", {
        toolName: "get_domain_overview",
        provider: "internal",
      }),
      ev("provider_success", {
        toolName: "get_domain_overview",
        provider: "internal",
      }),
      ev("provider_request", {
        toolName: "get_domain_overview",
        provider: "internal",
      }),
      ev("provider_success", {
        toolName: "get_domain_overview",
        provider: "internal",
      }),
      ev("tool_completed", { toolName: "get_domain_overview" }),
    ];
    const first = reduceTraceFrame(frame(events));
    const second = reduceTraceFrame(frame(events));
    expect(first.tools[0]?.providerBreakdown).toEqual([
      { provider: "dataforseo", calls: 1 },
      { provider: "internal", calls: 2 },
    ]);
    // Deterministic: same events → identical order (no object-key ordering).
    expect(second.tools[0]?.providerBreakdown).toEqual(
      first.tools[0]?.providerBreakdown,
    );
  });

  it("12. unknown provider: sanitized canonical id shown", () => {
    const view = reduceTraceFrame(
      frame([
        ...attemptPrefix("future_tool"),
        ev("provider_request", {
          toolName: "future_tool",
          provider: "new_vendor_v2",
        }),
        ev("provider_success", {
          toolName: "future_tool",
          provider: "new_vendor_v2",
        }),
        ev("tool_completed", { toolName: "future_tool" }),
      ]),
    );
    const tool = toolOf(view);
    expect(tool.providerBreakdown).toEqual([
      { provider: "new_vendor_v2", calls: 1 },
    ]);
    expect(formatProviderBreakdown(tool.providerBreakdown)).toBe(
      "new_vendor_v2 ×1",
    );
    expect(providerDisplayLabel("new_vendor_v2")).toBe("new_vendor_v2");
  });

  it("13. AI provider is never included in tool breakdown", () => {
    // Breakdown derives from provider_request events only — the frame's AI
    // header (Ollama Cloud) never appears as a tool provider.
    const view = reduceTraceFrame(
      frame([
        ...attemptPrefix("get_domain_overview"),
        ev("provider_request", {
          toolName: "get_domain_overview",
          provider: "internal",
        }),
        ev("provider_success", {
          toolName: "get_domain_overview",
          provider: "internal",
        }),
        ev("provider_request", {
          toolName: "get_domain_overview",
          provider: "dataforseo",
        }),
        ev("provider_success", {
          toolName: "get_domain_overview",
          provider: "dataforseo",
        }),
        ev("tool_completed", { toolName: "get_domain_overview" }),
      ]),
    );
    const tool = toolOf(view);
    expect(view.ai.provider).toBe("Ollama Cloud");
    const names = tool.providerBreakdown.map((e) => e.provider);
    expect(names).toEqual(["internal", "dataforseo"]);
    expect(names).not.toContain("Ollama Cloud");
    const rendered = formatProviderBreakdown(tool.providerBreakdown) ?? "";
    expect(rendered).not.toContain("Ollama");
    expect(rendered).toBe("Internal ×1 · DataForSEO ×1");
  });

  it("14. no secret leakage in breakdown rendering", () => {
    const view = reduceTraceFrame(
      frame([
        ...attemptPrefix("research_keywords"),
        // A poisoned provider id: the label util passes it through unchanged
        // (join-only formatting) — the server bus remains the scrub authority.
        ev("provider_request", {
          toolName: "research_keywords",
          provider: "Bearer sk-or-v1-secret",
        }),
        ev("tool_completed", { toolName: "research_keywords" }),
      ]),
    );
    const tool = toolOf(view);
    const rendered = formatProviderBreakdown(tool.providerBreakdown) ?? "";
    expect(rendered).toContain("×1");
    expect(rendered.length).toBeGreaterThan(0);
  });
});

describe("provider breakdown — labels", () => {
  it("maps canonical ids to friendly labels", () => {
    expect(providerDisplayLabel("dataforseo")).toBe("DataForSEO");
    expect(providerDisplayLabel("gsc")).toBe("GSC");
    expect(providerDisplayLabel("google_ads")).toBe("Google Ads");
    expect(providerDisplayLabel("bing_webmaster")).toBe("Bing Webmaster");
    expect(providerDisplayLabel("internal")).toBe("Internal");
    expect(providerDisplayLabel("local_crawler")).toBe("Local Crawler");
    expect(providerDisplayLabel("anything_else")).toBe("anything_else");
  });

  it("formats single and multi-provider compactly, null for empty", () => {
    expect(formatProviderBreakdown([])).toBeNull();
    expect(formatProviderBreakdown([{ provider: "gsc", calls: 1 }])).toBe(
      "GSC ×1",
    );
    expect(
      formatProviderBreakdown([
        { provider: "internal", calls: 2 },
        { provider: "dataforseo", calls: 2 },
      ]),
    ).toBe("Internal ×2 · DataForSEO ×2");
  });
});
