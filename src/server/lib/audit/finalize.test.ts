import { describe, expect, it } from "vitest";
import {
  hasCoverageDeficit,
  extractionCompleteRatio,
  enumerateDeficits,
  FINAL_AUDIT_STATUSES,
  isAuditStatus,
  resolveFinalStatus,
  ZERO_URL_COUNTERS,
  type AuditUrlCounters,
} from "./finalize";

function counters(over: Partial<AuditUrlCounters>): AuditUrlCounters {
  return { ...ZERO_URL_COUNTERS, ...over };
}

describe("resolveFinalStatus", () => {
  it("cancelled beats completed even when the queue drained", () => {
    expect(resolveFinalStatus({ cancelRequested: true, deficit: false })).toBe(
      "cancelled",
    );
    expect(resolveFinalStatus({ cancelRequested: true, deficit: true })).toBe(
      "cancelled",
    );
  });

  it("deficit yields completed_partial", () => {
    expect(resolveFinalStatus({ cancelRequested: false, deficit: true })).toBe(
      "completed_partial",
    );
  });

  it("clean run yields completed", () => {
    expect(resolveFinalStatus({ cancelRequested: false, deficit: false })).toBe(
      "completed",
    );
  });
});

describe("hasCoverageDeficit", () => {
  it("is clean when everything crawled was analyzed", () => {
    const cnt = counters({
      urlsDiscovered: 10,
      urlsFetched: 10,
      urlsAnalyzed: 10,
      urlsExtractionComplete: 10,
    });
    expect(hasCoverageDeficit({ counters: cnt, frontierRemaining: 0 })).toBe(
      false,
    );
  });

  it("flags blocked, failed, skipped and needing-render URLs", () => {
    const base = {
      urlsDiscovered: 10,
      urlsFetched: 10,
      urlsAnalyzed: 10,
      urlsExtractionComplete: 10,
    };
    expect(
      hasCoverageDeficit({
        counters: counters({ ...base, urlsBlocked: 1 }),
        frontierRemaining: 0,
      }),
    ).toBe(true);
    expect(
      hasCoverageDeficit({
        counters: counters({ ...base, urlsFailed: 1 }),
        frontierRemaining: 0,
      }),
    ).toBe(true);
    expect(
      hasCoverageDeficit({
        counters: counters({ ...base, urlsSkipped: 1 }),
        frontierRemaining: 0,
      }),
    ).toBe(true);
    expect(
      hasCoverageDeficit({
        counters: counters({ ...base, urlsRenderingRequired: 1 }),
        frontierRemaining: 0,
      }),
    ).toBe(true);
  });

  it("flags uncrawled frontier URLs", () => {
    expect(
      hasCoverageDeficit({
        counters: counters({ urlsDiscovered: 10, urlsFetched: 8 }),
        frontierRemaining: 2,
      }),
    ).toBe(true);
  });
});

describe("extractionCompleteRatio", () => {
  it("returns the ratio between 0 and 1", () => {
    expect(
      extractionCompleteRatio(
        counters({
          urlsAnalyzed: 10,
          urlsRenderingRequired: 0,
          urlsExtractionComplete: 7,
        }),
      ),
    ).toBe(0.7);
    expect(
      extractionCompleteRatio(
        counters({
          urlsAnalyzed: 5,
          urlsRenderingRequired: 5,
          urlsExtractionComplete: 5,
        }),
      ),
    ).toBe(0.5);
  });

  it("is null when there is nothing to report", () => {
    expect(extractionCompleteRatio(ZERO_URL_COUNTERS)).toBeNull();
  });
});

describe("enumerateDeficits", () => {
  it("omits zero buckets and lists non-zero ones", () => {
    const list = enumerateDeficits({
      counters: counters({ urlsBlocked: 2, urlsRenderingRequired: 3 }),
      frontierRemaining: 5,
    });
    expect(list).toEqual([
      { key: "blocked", count: 2 },
      { key: "rendering_required", count: 3 },
      { key: "not_crawled", count: 5 },
    ]);
  });

  it("is empty for a clean audit", () => {
    expect(
      enumerateDeficits({
        counters: counters({
          urlsDiscovered: 4,
          urlsFetched: 4,
          urlsAnalyzed: 4,
        }),
        frontierRemaining: 0,
      }),
    ).toEqual([]);
  });
});

describe("isAuditStatus / FINAL_AUDIT_STATUSES", () => {
  it("accepts every canonical status", () => {
    for (const status of [
      "running",
      "completed",
      "failed",
      "cancelled",
      "completed_partial",
    ] as const) {
      expect(isAuditStatus(status)).toBe(true);
    }
    // The status resolver only ever produces finalize outcomes; "failed"
    // comes from the workflow error path instead.
    for (const status of [
      "completed",
      "completed_partial",
      "cancelled",
    ] as const) {
      expect(FINAL_AUDIT_STATUSES).toContain(status);
    }
  });

  it("rejects unknown values", () => {
    expect(isAuditStatus("queued")).toBe(false);
    expect(isAuditStatus("")).toBe(false);
  });
});
