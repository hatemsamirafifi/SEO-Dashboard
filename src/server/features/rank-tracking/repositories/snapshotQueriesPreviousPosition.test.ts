import { describe, expect, it } from "vitest";

interface TestSnapshot {
  runId: string;
  trackingKeywordId: string;
  device: "desktop" | "mobile";
  checkedAt: string;
  position: number | null;
  previousPosition: number | null;
  rankingStatus: "RANKED" | "NO_RESULT" | "CHECK_FAILED" | null;
}

interface TestRun {
  id: string;
  configId: string;
  status: "completed" | "running" | "failed" | "pending";
}

/**
 * Pure simulation of getLatestPositionsMap query resolution semantics:
 * - Scoped to completed runs for the config
 * - Excludes current runId (both from runs and snapshots)
 * - Excludes CHECK_FAILED snapshots from altering previous known position
 * - Picks the latest valid snapshot before the check
 * - Preserves null (never converts to 0)
 */
function resolvePreviousPosition(
  configId: string,
  pairs: Array<{ keywordId: string; device: "desktop" | "mobile" }>,
  runs: TestRun[],
  snapshots: TestSnapshot[],
  options?: { excludeRunId?: string; beforeDate?: string },
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const completedRunIds = new Set(
    runs
      .filter(
        (r) =>
          r.configId === configId &&
          r.status === "completed" &&
          (!options?.excludeRunId || r.id !== options.excludeRunId),
      )
      .map((r) => r.id),
  );

  for (const pair of pairs) {
    const validSnapshots = snapshots
      .filter((s) => {
        if (s.trackingKeywordId !== pair.keywordId || s.device !== pair.device) return false;
        if (!completedRunIds.has(s.runId)) return false;
        if (options?.excludeRunId && s.runId === options.excludeRunId) return false;
        if (options?.beforeDate && s.checkedAt >= options.beforeDate) return false;
        // Provider failure must not erase or overwrite previous known ranking
        if (s.rankingStatus === "CHECK_FAILED") return false;
        return true;
      })
      .toSorted((a, b) => b.checkedAt.localeCompare(a.checkedAt));

    if (validSnapshots.length > 0) {
      result.set(`${pair.keywordId}:${pair.device}`, validSnapshots[0].position);
    }
  }

  return result;
}

describe("previousPosition resolution semantics", () => {
  const configId = "cfg-1";
  const kwX = "kw-x";
  const kwY = "kw-y";

  it("1. resolves previous successful rank correctly", () => {
    const runs: TestRun[] = [{ id: "run-A", configId, status: "completed" }];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-A",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: 14,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
    ];

    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: "run-B" },
    );

    expect(prevMap.get(`${kwX}:desktop`)).toBe(14);
  });

  it("2. resolves previous NO_RESULT as null (never 0)", () => {
    const runs: TestRun[] = [{ id: "run-A", configId, status: "completed" }];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-A",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      },
    ];

    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: "run-B" },
    );

    expect(prevMap.has(`${kwX}:desktop`)).toBe(true);
    expect(prevMap.get(`${kwX}:desktop`)).toBeNull();
    expect(prevMap.get(`${kwX}:desktop`)).not.toBe(0);
  });

  it("3. ignores CHECK_FAILED snapshots when looking back for known position", () => {
    const runs: TestRun[] = [
      { id: "run-1", configId, status: "completed" },
      { id: "run-2", configId, status: "completed" },
    ];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-1",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: 14,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-2",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-12 10:00:00",
        position: null,
        previousPosition: 14,
        rankingStatus: "CHECK_FAILED",
      },
    ];

    // Check on 2026-09-13 (run-3): should look past run-2 (CHECK_FAILED) to run-1 (14)
    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: "run-3" },
    );

    expect(prevMap.get(`${kwX}:desktop`)).toBe(14);
  });

  it("4. selects the latest snapshot chronologically when multiple exist", () => {
    const runs: TestRun[] = [
      { id: "run-1", configId, status: "completed" },
      { id: "run-2", configId, status: "completed" },
      { id: "run-3", configId, status: "completed" },
    ];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-1",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-01 10:00:00",
        position: 25,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-2",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-05 10:00:00",
        position: 18,
        previousPosition: 25,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-3",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: 12,
        previousPosition: 18,
        rankingStatus: "RANKED",
      },
    ];

    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: "run-4" },
    );

    expect(prevMap.get(`${kwX}:desktop`)).toBe(12);
  });

  it("5. strictly excludes snapshots created during the current run", () => {
    const currentRunId = "run-B";
    const runs: TestRun[] = [
      { id: "run-A", configId, status: "completed" },
      { id: currentRunId, configId, status: "completed" },
    ];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-A",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: 14,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        // Snapshot already inserted earlier in current run
        runId: currentRunId,
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-13 10:00:00",
        position: 9,
        previousPosition: 14,
        rankingStatus: "RANKED",
      },
    ];

    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: currentRunId },
    );

    // Must resolve to 14, NEVER 9
    expect(prevMap.get(`${kwX}:desktop`)).toBe(14);
    expect(prevMap.get(`${kwX}:desktop`)).not.toBe(9);
  });

  it("6. resolves independent previous positions for multiple keywords in the same run", () => {
    const runs: TestRun[] = [{ id: "run-A", configId, status: "completed" }];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-A",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: 3,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-A",
        trackingKeywordId: kwY,
        device: "desktop",
        checkedAt: "2026-09-10 10:00:00",
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      },
    ];

    const prevMap = resolvePreviousPosition(
      configId,
      [
        { keywordId: kwX, device: "desktop" },
        { keywordId: kwY, device: "desktop" },
      ],
      runs,
      snapshots,
      { excludeRunId: "run-B" },
    );

    expect(prevMap.get(`${kwX}:desktop`)).toBe(3);
    expect(prevMap.get(`${kwY}:desktop`)).toBeNull();
  });

  it("7. handles duplicate/retry attempt without polluting lookup", () => {
    const retryRunId = "run-retry";
    const runs: TestRun[] = [
      { id: "run-orig", configId, status: "completed" },
      { id: retryRunId, configId, status: "completed" },
    ];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-orig",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-01 10:00:00",
        position: 7,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: retryRunId,
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-02 10:00:00",
        position: 5,
        previousPosition: 7,
        rankingStatus: "RANKED",
      },
    ];

    // If run-retry is being retried, excludeRunId keeps it isolated to run-orig
    const prevMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: retryRunId },
    );

    expect(prevMap.get(`${kwX}:desktop`)).toBe(7);
  });

  it("8. ensures determinism regardless of concurrent batch execution order", () => {
    const runs: TestRun[] = [{ id: "run-1", configId, status: "completed" }];
    const snapshots: TestSnapshot[] = [
      {
        runId: "run-1",
        trackingKeywordId: kwX,
        device: "desktop",
        checkedAt: "2026-09-01 10:00:00",
        position: 15,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-1",
        trackingKeywordId: kwY,
        device: "desktop",
        checkedAt: "2026-09-01 10:00:00",
        position: 22,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
    ];

    const currentRun = "run-2";
    // Batch A queries first
    const batchAMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: currentRun },
    );

    // Batch A inserts its result
    snapshots.push({
      runId: currentRun,
      trackingKeywordId: kwX,
      device: "desktop",
      checkedAt: "2026-09-02 10:00:00",
      position: 10,
      previousPosition: 15,
      rankingStatus: "RANKED",
    });

    // Batch B queries later in the same run
    const batchBMap = resolvePreviousPosition(
      configId,
      [{ keywordId: kwY, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: currentRun },
    );

    // If Batch A re-queries, its previous position remains deterministic
    const batchARequery = resolvePreviousPosition(
      configId,
      [{ keywordId: kwX, device: "desktop" }],
      runs,
      snapshots,
      { excludeRunId: currentRun },
    );

    expect(batchAMap.get(`${kwX}:desktop`)).toBe(15);
    expect(batchBMap.get(`${kwY}:desktop`)).toBe(22);
    expect(batchARequery.get(`${kwX}:desktop`)).toBe(15);
  });
});
