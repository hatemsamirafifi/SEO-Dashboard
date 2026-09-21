import { describe, expect, it } from "vitest";
import { syncStatusCopy, toSyncStatusView } from "./syncStatusCopy";

describe("syncStatusCopy", () => {
  it("hides the block while loading or not connected", () => {
    expect(syncStatusCopy({ kind: "loading" }).headline).toBeNull();
    expect(syncStatusCopy({ kind: "not-connected" }).headline).toBeNull();
    expect(syncStatusCopy({ kind: "not-connected" }).showTrigger).toBe(false);
  });

  it("offers retry on load errors", () => {
    const copy = syncStatusCopy({ kind: "error" });
    expect(copy.headline).toContain("Could not load");
    expect(copy.showRetry).toBe(true);
    expect(copy.showTrigger).toBe(false);
  });

  it("shows syncing without a trigger", () => {
    const copy = syncStatusCopy({ kind: "syncing" });
    expect(copy.headline).toContain("Syncing");
    expect(copy.showTrigger).toBe(false);
    expect(copy.triggerDisabled).toBe(true);
  });

  it("invites a first sync when nothing synced yet", () => {
    const copy = syncStatusCopy({ kind: "never-synced" });
    expect(copy.headline).toContain("No Analytics data synced yet");
    expect(copy.showTrigger).toBe(true);
  });

  it("renders failure, partial, and completed results distinctly", () => {
    const failed = syncStatusCopy({
      kind: "last-result",
      status: "failed",
      error: "QUOTA_EXHAUSTED: quota exhausted",
      lastFullyCoveredDate: "2025-01-01",
    });
    expect(failed.headline).toContain("Last sync failed");
    expect(failed.headline).toContain("QUOTA_EXHAUSTED");
    expect(failed.showTrigger).toBe(true);

    const partial = syncStatusCopy({
      kind: "last-result",
      status: "partial",
      error: null,
      lastFullyCoveredDate: "2025-01-05",
    });
    expect(partial.headline).toContain("partially completed");
    expect(partial.headline).toContain("2025-01-05");

    const completed = syncStatusCopy({
      kind: "last-result",
      status: "completed",
      error: null,
      lastFullyCoveredDate: "2025-01-07",
    });
    expect(completed.headline).toContain("through 2025-01-07");
  });
});

describe("toSyncStatusView", () => {
  it("maps running, missing, and known terminal states", () => {
    expect(
      toSyncStatusView({
        connected: true,
        isRunning: true,
        latestSync: null,
        lastFullyCoveredDate: null,
      }),
    ).toEqual({ kind: "syncing" });
    expect(
      toSyncStatusView({
        connected: false,
        isRunning: false,
        latestSync: null,
        lastFullyCoveredDate: null,
      }),
    ).toEqual({ kind: "not-connected" });
    expect(
      toSyncStatusView({
        connected: true,
        isRunning: false,
        latestSync: { status: "completed" },
        lastFullyCoveredDate: "2025-01-07",
      }),
    ).toEqual({
      kind: "last-result",
      status: "completed",
      error: null,
      lastFullyCoveredDate: "2025-01-07",
    });
  });

  it("degrades unknown latest-sync states to never-synced", () => {
    expect(
      toSyncStatusView({
        connected: true,
        isRunning: false,
        latestSync: { status: "mystery" },
        lastFullyCoveredDate: null,
      }),
    ).toEqual({ kind: "never-synced" });
  });
});
