import { describe, expect, it } from "vitest";
import {
  serpClusterCoverageBadge,
  serpClusterCoverageLabel,
  serpClusterNewPagesLabel,
  serpClusterSummary,
  SERP_CLUSTER_FORWARD_LOOKING_NOTE,
} from "./serpClusteringCopy";

describe("serp clustering copy (spec 019)", () => {
  it("labels the coverage states and degrades unknown values", () => {
    expect(serpClusterCoverageLabel("ready")).toBe("Ready");
    expect(serpClusterCoverageLabel("awaiting_data")).toBe(
      "Awaiting SERP data",
    );
    expect(serpClusterCoverageLabel("insufficient_data")).toBe(
      "Insufficient data",
    );
    expect(serpClusterCoverageLabel("stale_data")).toBe("Stale data");
    expect(serpClusterCoverageLabel("future_state")).toBe("Unknown");
    expect(serpClusterCoverageBadge("ready")).toBe("badge-success");
    expect(serpClusterCoverageBadge("future_state")).toBe("badge-ghost");
  });

  it("summarises the observed clusters", () => {
    expect(
      serpClusterSummary({
        clusterCount: 0,
        coveredKeywords: 0,
        trackedKeywords: 10,
      }),
    ).toBe("No clusters observed yet.");
    expect(
      serpClusterSummary({
        clusterCount: 1,
        coveredKeywords: 8,
        trackedKeywords: 10,
      }),
    ).toBe("1 cluster observed on 8 of 10 tracked keywords.");
    expect(
      serpClusterSummary({
        clusterCount: 2,
        coveredKeywords: 8,
        trackedKeywords: 10,
      }),
    ).toBe("2 clusters observed on 8 of 10 tracked keywords.");
  });

  it("describes the pages outside the project", () => {
    expect(serpClusterNewPagesLabel(0)).toBe("No pages outside this project.");
    expect(serpClusterNewPagesLabel(1)).toBe("1 page not on this project.");
    expect(serpClusterNewPagesLabel(2)).toBe("2 pages not on this project.");
  });

  it("keeps the forward-looking caveat", () => {
    expect(SERP_CLUSTER_FORWARD_LOOKING_NOTE).toContain("Forward-looking");
    expect(SERP_CLUSTER_FORWARD_LOOKING_NOTE).toContain("not a prediction");
    expect(SERP_CLUSTER_FORWARD_LOOKING_NOTE).not.toMatch(
      /caused|because of|due to|led to|resulted in|triggered/i,
    );
  });
});
