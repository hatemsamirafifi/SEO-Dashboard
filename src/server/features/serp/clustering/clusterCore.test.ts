import { describe, expect, it } from "vitest";
import {
  clusterSerpPages,
  computeClusterCoverage,
  type ClusterInput,
} from "./clusterCore";

function keyword(name: string, pages: string[]): ClusterInput {
  return {
    keyword: name,
    pages: pages.map((url, index) => ({
      url,
      normalizedUrl: url,
      domain: new URL(url).hostname,
      position: index + 1,
    })),
  };
}

const options = {
  threshold: 3,
  minCoverageRatio: 0.8,
  trackedDomain: "example.com",
  trackedKeywordCount: 5,
  freshestObservedAt: "2026-01-28T10:00:00.000Z",
};

describe("clusterSerpPages (spec 019)", () => {
  it("clusters pages that co-occur on at least the threshold of keywords", () => {
    const { clusters } = clusterSerpPages(
      [
        keyword("k1", ["https://a.com/1", "https://b.com/1"]),
        keyword("k2", ["https://a.com/1", "https://b.com/1"]),
        keyword("k3", ["https://a.com/1", "https://b.com/1"]),
        keyword("k4", ["https://c.com/1"]),
      ],
      options,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.keywordCount).toBe(3);
    expect(clusters[0]?.pages.map((page) => page.normalizedUrl)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
    ]);
    expect(clusters[0]?.keywords).toEqual(["k1", "k2", "k3"]);
  });

  it("does not cluster pages that share fewer than the threshold", () => {
    const { clusters } = clusterSerpPages(
      [
        keyword("k1", ["https://a.com/1", "https://b.com/1"]),
        keyword("k2", ["https://a.com/1", "https://b.com/1"]),
      ],
      options,
    );

    expect(clusters).toEqual([]);
  });

  it("keeps groups apart when only a weakly shared page joins them", () => {
    // a+b share three keywords, c+d share three keywords, and the bridge
    // page only shares two keywords with each group.
    const { clusters } = clusterSerpPages(
      [
        keyword("k1", [
          "https://a.com/1",
          "https://b.com/1",
          "https://x.com/1",
        ]),
        keyword("k2", [
          "https://a.com/1",
          "https://b.com/1",
          "https://x.com/1",
        ]),
        keyword("k3", ["https://a.com/1", "https://b.com/1"]),
        keyword("k4", [
          "https://c.com/1",
          "https://d.com/1",
          "https://x.com/1",
        ]),
        keyword("k5", [
          "https://c.com/1",
          "https://d.com/1",
          "https://x.com/1",
        ]),
        keyword("k6", ["https://c.com/1", "https://d.com/1"]),
      ],
      options,
    );

    expect(clusters).toHaveLength(2);
    const memberSets = clusters.map((cluster) =>
      cluster.pages.map((page) => page.normalizedUrl).toSorted(),
    );
    expect(memberSets).toContainEqual(["https://a.com/1", "https://b.com/1"]);
    expect(memberSets).toContainEqual(["https://c.com/1", "https://d.com/1"]);
    for (const members of memberSets) {
      expect(members).not.toContain("https://x.com/1");
    }
  });

  it("flags the pages the project does not own", () => {
    const { clusters } = clusterSerpPages(
      [
        keyword("k1", ["https://example.com/1", "https://other.com/1"]),
        keyword("k2", ["https://example.com/1", "https://other.com/1"]),
        keyword("k3", ["https://example.com/1", "https://other.com/1"]),
      ],
      options,
    );

    expect(clusters[0]?.newPageUrls).toEqual(["https://other.com/1"]);
  });

  it("is deterministic for identical inputs", () => {
    const inputs = [
      keyword("k1", ["https://a.com/1", "https://b.com/1"]),
      keyword("k2", ["https://a.com/1", "https://b.com/1"]),
      keyword("k3", ["https://a.com/1", "https://b.com/1"]),
    ];
    const first = clusterSerpPages(inputs, options);
    const second = clusterSerpPages(inputs.toReversed(), options);
    expect(second.clusters).toEqual(first.clusters);
  });
});

describe("computeClusterCoverage (spec 019)", () => {
  it("reports awaiting data when nothing was stored", () => {
    const coverage = computeClusterCoverage({
      coveredKeywords: 0,
      trackedKeywords: 5,
      storedRows: 0,
      freshestObservedAt: null,
      minCoverageRatio: 0.8,
    });

    expect(coverage).toMatchObject({
      status: "awaiting_data",
      percent: 0,
      trackedKeywords: 5,
    });
  });

  it("reports insufficient data below the coverage ratio", () => {
    const coverage = computeClusterCoverage({
      coveredKeywords: 2,
      trackedKeywords: 5,
      storedRows: 4,
      freshestObservedAt: "2026-01-28T10:00:00.000Z",
      minCoverageRatio: 0.8,
    });

    expect(coverage.status).toBe("insufficient_data");
    expect(coverage.percent).toBe(40);
  });

  it("reports ready with the covered share", () => {
    const coverage = computeClusterCoverage({
      coveredKeywords: 5,
      trackedKeywords: 5,
      storedRows: 20,
      freshestObservedAt: "2026-01-28T10:00:00.000Z",
      minCoverageRatio: 0.8,
    });

    expect(coverage.status).toBe("ready");
    expect(coverage.percent).toBe(100);
  });
});
