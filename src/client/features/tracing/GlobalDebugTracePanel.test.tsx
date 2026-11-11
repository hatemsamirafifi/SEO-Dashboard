import { describe, expect, it, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { GlobalDebugTracePanel } from "./GlobalDebugTracePanel";
import { globalTraceStore } from "./globalTraceStore";

describe("GlobalDebugTracePanel scoping and visibility", () => {
  beforeEach(() => {
    globalTraceStore.clearTrace();
    globalTraceStore.setDiagnosticsEnabled(true);
  });

  it("renders all operations when projectId is undefined (global settings mode)", () => {
    globalTraceStore.recordOperation({
      feature: "settings",
      startedAt: Date.now(),
      operation: "settings.dataforseo.status_check",
      source: "Settings",
      status: "success",
      billing: "Free",
      metered: false,
      budget: "PASS",
      cache: "Not applicable",
      retry: { attempted: false, count: 0 },
      providerCalls: 1,
      httpStatus: 200,
    });

    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      startedAt: Date.now(),
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "project_123",
      status: "success",
      billing: "Paid",
      metered: true,
      budget: "PASS",
      cache: "Not applicable",
      retry: { attempted: false, count: 0 },
      providerCalls: 2,
    });

    const html = renderToStaticMarkup(
      React.createElement(GlobalDebugTracePanel, {}),
    );

    // In global mode without projectId, all operations are visible (2 total)
    expect(html).toContain("2 of 2 operations visible");
    expect(html).toContain("settings.dataforseo.status_check");
    expect(html).toContain("rank_tracking.check_selected");
  });

  it("provides project scope toggle and empty state action when project has 0 operations", () => {
    // Record operation for a different project
    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      startedAt: Date.now(),
      operation: "rank_tracking.check_all",
      source: "Rank Tracking page",
      projectId: "other_project",
      status: "success",
      billing: "Paid",
      metered: true,
      budget: "PASS",
      cache: "Not applicable",
      retry: { attempted: false, count: 0 },
      providerCalls: 1,
    });

    const html = renderToStaticMarkup(
      React.createElement(GlobalDebugTracePanel, {
        projectId: "empty_project",
      }),
    );

    // Shows scope toggle
    expect(html).toContain("Current project");
    expect(html).toContain("All (1)");
    // Explains that operations exist in other projects
    expect(html).toContain("available across all projects");
    expect(html).toContain("View all 1 operations");
  });
});
