/**
 * FIX 2 validation tests: the durable dispatch state machine for the paid,
 * non-idempotent SE Ranking recheck POST.
 *
 * Pins eight properties:
 *  a. Happy path: PENDING → DISPATCHED → CONFIRMED, exactly one POST.
 *  b. Restart with a DISPATCHED record → POST skipped (no double billing).
 *  c. Transport timeout after send → record OUTCOME_UNKNOWN, no claim.
 *  d. Restart with an OUTCOME_UNKNOWN record → POST NOT resent, warning raised.
 *  e. Concurrent duplicate (lost insert race) → gates on the winner's record.
 *  f. Definitive 4xx-class refusal → REJECTED + NonRetryableError (no retry).
 *  g. 5xx / upstream-unavailable after send → OUTCOME_UNKNOWN (ambiguous).
 *  h. Two engines in one run → one dispatch record, both pairs in scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeRankingLib from "@/server/lib/seranking";

const dispatchRepoMocks = vi.hoisted(() => ({
  getDispatchById: vi.fn(),
  createDispatch: vi.fn(),
  updateDispatch: vi.fn(),
}));

const projectServiceMocks = vi.hoisted(() => ({
  recheckPositions: vi.fn(),
}));

vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/SeRankingRecheckDispatchRepository",
  () => ({ SeRankingRecheckDispatchRepository: dispatchRepoMocks }),
);

vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<typeof SeRankingLib>();
  return {
    ...actual,
    SeRankingProjectService: projectServiceMocks,
  };
});

import { NonRetryableError } from "cloudflare:workflows";
import { AppError } from "@/server/lib/errors";
import {
  buildRecheckDispatchScope,
  dispatchSeRankingRecheck,
  recheckDispatchId,
  type RecheckDispatchScopeEntry,
} from "./seRankingCheckDispatch";

const recheckParams = {
  siteId: 5001,
  engineKeywordPairs: [
    { siteEngineId: 1001, keywordId: "88001" },
    { siteEngineId: 1002, keywordId: "88001" },
  ],
} as const;

const dispatchScope = JSON.stringify([
  { siteEngineId: 1001, remoteKeywordId: "88001" },
  { siteEngineId: 1002, remoteKeywordId: "88001" },
]);

function record(
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: recheckDispatchId("run-1", "cfg-1", dispatchScope),
    runId: "run-1",
    configId: "cfg-1",
    dispatchScope,
    status,
    providerResponse: null,
    dispatchedAt: null,
    outcomeAt: null,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function callDispatch() {
  return dispatchSeRankingRecheck({
    // oxlint-disable-next-line typescript/no-explicit-any
    client: {} as any,
    remoteSiteId: 5001,
    runId: "run-1",
    configId: "cfg-1",
    dispatchScope,
    // RecheckParams is readonly-typed in the module; the test const is frozen.
    // oxlint-disable-next-line typescript/no-explicit-any
    recheckParams: recheckParams as any,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dispatchRepoMocks.getDispatchById.mockResolvedValue(null);
  dispatchRepoMocks.createDispatch.mockImplementation(async (data) => ({
    ...record("PENDING"),
    ...data,
  }));
  dispatchRepoMocks.updateDispatch.mockResolvedValue(undefined);
  projectServiceMocks.recheckPositions.mockResolvedValue({
    ok: true,
    status: "queued",
  });
});

describe("dispatchSeRankingRecheck — durable paid-POST dispatch", () => {
  it("(a) happy path: creates PENDING, marks DISPATCHED then CONFIRMED around exactly one POST", async () => {
    const outcome = await callDispatch();

    expect(outcome).toEqual({ outcome: "dispatched" });
    expect(projectServiceMocks.recheckPositions).toHaveBeenCalledTimes(1);
    expect(projectServiceMocks.recheckPositions).toHaveBeenCalledWith(
      expect.anything(),
      recheckParams,
    );

    const statuses = dispatchRepoMocks.updateDispatch.mock.calls.map(
      (call) => (call[1] as { status: string }).status,
    );
    expect(statuses).toEqual(["DISPATCHED", "CONFIRMED"]);
    const dispatched = dispatchRepoMocks.updateDispatch.mock.calls[0]?.[1] as {
      dispatchedAt: number;
    };
    expect(dispatched.dispatchedAt).toBeGreaterThan(0);
    const confirmed = dispatchRepoMocks.updateDispatch.mock.calls[1]?.[1] as {
      outcomeAt: number;
      providerResponse: string;
    };
    expect(confirmed.outcomeAt).toBeGreaterThan(0);
    expect(JSON.parse(confirmed.providerResponse)).toMatchObject({
      ok: true,
      status: "queued",
    });
  });

  it("(b) restart with a DISPATCHED record skips the POST entirely", async () => {
    dispatchRepoMocks.getDispatchById.mockResolvedValue(
      record("DISPATCHED", { dispatchedAt: 1700000000100 }),
    );

    const outcome = await callDispatch();

    expect(outcome).toEqual({
      outcome: "already_dispatched",
      status: "DISPATCHED",
    });
    expect(projectServiceMocks.recheckPositions).not.toHaveBeenCalled();
    expect(dispatchRepoMocks.createDispatch).not.toHaveBeenCalled();
    expect(dispatchRepoMocks.updateDispatch).not.toHaveBeenCalled();
  });

  it("(c) transport timeout after the POST was sent records OUTCOME_UNKNOWN without claiming success", async () => {
    projectServiceMocks.recheckPositions.mockRejectedValue(
      Object.assign(new Error("Request timed out"), { statusCode: 504 }),
    );

    const outcome = await callDispatch();

    expect(outcome.outcome).toBe("outcome_unknown");
    expect((outcome as { warning: string }).warning).toContain(
      "may or may not have been accepted",
    );

    const statuses = dispatchRepoMocks.updateDispatch.mock.calls.map(
      (call) => (call[1] as { status: string }).status,
    );
    expect(statuses).toEqual(["DISPATCHED", "OUTCOME_UNKNOWN"]);
    const unknown = dispatchRepoMocks.updateDispatch.mock.calls[1]?.[1] as {
      providerResponse: string;
    };
    expect(JSON.parse(unknown.providerResponse)).toMatchObject({
      name: "Error",
      message: "Request timed out",
    });
  });

  it("(d) restart with an OUTCOME_UNKNOWN record does NOT resend the POST and raises a warning", async () => {
    dispatchRepoMocks.getDispatchById.mockResolvedValue(
      record("OUTCOME_UNKNOWN", { outcomeAt: 1700000000100 }),
    );

    const outcome = await callDispatch();

    expect(outcome.outcome).toBe("outcome_unknown");
    expect((outcome as { warning: string }).warning).toContain("NOT resending");
    expect(projectServiceMocks.recheckPositions).not.toHaveBeenCalled();
    expect(dispatchRepoMocks.updateDispatch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("outcome is UNKNOWN"),
    );
  });

  it("(e) concurrent duplicate: lost insert race gates on the winner's DISPATCHED record", async () => {
    dispatchRepoMocks.createDispatch.mockResolvedValue(null);
    dispatchRepoMocks.getDispatchById
      .mockResolvedValueOnce(null) // initial read
      .mockResolvedValueOnce(record("DISPATCHED")); // re-read after race loss

    const outcome = await callDispatch();

    expect(outcome).toEqual({
      outcome: "already_dispatched",
      status: "DISPATCHED",
    });
    expect(dispatchRepoMocks.createDispatch).toHaveBeenCalledTimes(1);
    expect(projectServiceMocks.recheckPositions).not.toHaveBeenCalled();
  });

  it("(f) definitive 4xx-class refusal records REJECTED and throws NonRetryableError without retry", async () => {
    projectServiceMocks.recheckPositions.mockRejectedValue(
      new AppError("VALIDATION_ERROR", "invalid engine ids"),
    );

    await expect(callDispatch()).rejects.toBeInstanceOf(NonRetryableError);

    const statuses = dispatchRepoMocks.updateDispatch.mock.calls.map(
      (call) => (call[1] as { status: string }).status,
    );
    expect(statuses).toEqual(["DISPATCHED", "REJECTED"]);
    const rejected = dispatchRepoMocks.updateDispatch.mock.calls[1]?.[1] as {
      providerResponse: string;
    };
    expect(JSON.parse(rejected.providerResponse)).toMatchObject({
      name: "AppError",
      code: "VALIDATION_ERROR",
    });
    // Only the DISPATCHED marker then the terminal REJECTED marker: no retry
    // loop re-issued the POST.
    expect(projectServiceMocks.recheckPositions).toHaveBeenCalledTimes(1);
  });

  it("(g) 503 / upstream-unavailable after send records OUTCOME_UNKNOWN (ambiguous, not REJECTED)", async () => {
    projectServiceMocks.recheckPositions.mockRejectedValue(
      new AppError("TRANSIENT_UPSTREAM", "service unavailable"),
    );

    const outcome = await callDispatch();

    expect(outcome.outcome).toBe("outcome_unknown");
    const statuses = dispatchRepoMocks.updateDispatch.mock.calls.map(
      (call) => (call[1] as { status: string }).status,
    );
    expect(statuses).toEqual(["DISPATCHED", "OUTCOME_UNKNOWN"]);
  });

  it("(h) two engines in one run produce a single dispatch record containing both pairs in scope", async () => {
    const scope = buildRecheckDispatchScope([
      { remoteSiteEngineId: 1001, remoteKeywordId: "88001" },
      { remoteSiteEngineId: 1002, remoteKeywordId: "88001" },
    ]);

    const entries = JSON.parse(scope) as RecheckDispatchScopeEntry[];
    expect(entries).toHaveLength(2);
    expect(
      entries.map((e) => e.siteEngineId ?? 0).toSorted((a, b) => a - b),
    ).toEqual([1001, 1002]);
    expect(new Set(entries.map((e) => e.remoteKeywordId))).toEqual(
      new Set(["88001"]),
    );

    await dispatchSeRankingRecheck({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-1",
      configId: "cfg-1",
      dispatchScope: scope,
      recheckParams: {
        siteId: 5001,
        engineKeywordPairs: [
          { siteEngineId: 1001, keywordId: "88001" },
          { siteEngineId: 1002, keywordId: "88001" },
        ],
      },
    });

    expect(dispatchRepoMocks.createDispatch).toHaveBeenCalledTimes(1);
    const created = dispatchRepoMocks.createDispatch.mock.calls[0]?.[0] as {
      id: string;
      dispatchScope: string;
      status: string;
    };
    expect(created.id).toBe(recheckDispatchId("run-1", "cfg-1", scope));
    expect(created.status).toBe("PENDING");
    expect(JSON.parse(created.dispatchScope)).toHaveLength(2);
    // One POST covers both engines (pairs batched into a single recheck call).
    expect(projectServiceMocks.recheckPositions).toHaveBeenCalledTimes(1);
  });
});
