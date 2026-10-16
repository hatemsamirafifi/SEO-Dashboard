import { describe, expect, it } from "vitest";
import { startAutopilotRunSchema } from "./autopilot";

// Spec 013 (Setup T002): the allowlist is enforced at the trust boundary —
// startAutopilotRunSchema.workflowType is z.enum(AUTOPILOT_WORKFLOW_TYPES).
const allowlisted = [
  "growth_plan",
  "quick_wins",
  "traffic_drop",
  "content_refresh",
  "technical_seo",
  "monthly_review",
  "competitor_gap",
] as const;

describe("startAutopilotRunSchema workflow allowlist", () => {
  it("accepts each allowlisted workflow type", () => {
    for (const workflowType of allowlisted) {
      expect(
        startAutopilotRunSchema.safeParse({ projectId: "p1", workflowType })
          .success,
      ).toBe(true);
    }
  });

  it("rejects non-allowlisted and arbitrary workflow types", () => {
    for (const workflowType of ["arbitrary_workflow", ""]) {
      expect(
        startAutopilotRunSchema.safeParse({ projectId: "p1", workflowType })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an overlong trigger value", () => {
    expect(
      startAutopilotRunSchema.safeParse({
        projectId: "p1",
        workflowType: "growth_plan",
        trigger: "x".repeat(41),
      }).success,
    ).toBe(false);
    expect(
      startAutopilotRunSchema.safeParse({
        projectId: "p1",
        workflowType: "growth_plan",
        trigger: "sam_chat",
      }).success,
    ).toBe(true);
  });
});
