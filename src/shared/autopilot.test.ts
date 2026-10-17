import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_WORKFLOW_DESCRIPTIONS,
  AUTOPILOT_WORKFLOW_LABELS,
  AUTOPILOT_WORKFLOW_TYPES,
  isAutopilotWorkflowType,
} from "./autopilot";

// Spec 013 (Setup T001): the allowlist is one shared const — six registered
// workflows, consumed by the UI picker, Zod trust boundaries, and SAM tools.

describe("autopilot workflow allowlist", () => {
  it("lists the seven registered workflows in wave order", () => {
    expect([...AUTOPILOT_WORKFLOW_TYPES]).toEqual([
      "growth_plan",
      "quick_wins",
      "traffic_drop",
      "content_refresh",
      "technical_seo",
      "monthly_review",
      "competitor_gap",
    ]);
  });

  it("has exactly one label and one description per workflow type", () => {
    for (const type of AUTOPILOT_WORKFLOW_TYPES) {
      expect(typeof AUTOPILOT_WORKFLOW_LABELS[type]).toBe("string");
      expect(AUTOPILOT_WORKFLOW_LABELS[type].length).toBeGreaterThan(0);
      expect(typeof AUTOPILOT_WORKFLOW_DESCRIPTIONS[type]).toBe("string");
      expect(AUTOPILOT_WORKFLOW_DESCRIPTIONS[type].length).toBeGreaterThan(0);
    }
  });

  it("includes the competitor-gap workflow implemented behind G5 gate (spec 014)", () => {
    expect(isAutopilotWorkflowType("competitor_gap")).toBe(true);
    expect(isAutopilotWorkflowType("arbitrary_workflow")).toBe(false);
    expect(isAutopilotWorkflowType("")).toBe(false);
  });
});
