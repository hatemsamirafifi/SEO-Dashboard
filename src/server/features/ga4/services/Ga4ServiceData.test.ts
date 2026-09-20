import { beforeEach, describe, expect, it, vi } from "vitest";

// R2 cache primitives — the GA4 service uses them directly (not router-shaped
// SeoCacheService requests).
const mocks = vi.hoisted(() => ({
  getCached: vi.fn<(key: string) => Promise<unknown>>(async () => null),
  setCached: vi.fn<(key: string, data: unknown, ttl: number) => Promise<void>>(
    async () => {},
  ),
  buildCacheKey: vi.fn<
    (prefix: string, params: Record<string, unknown>) => Promise<string>
  >(
    async (prefix, params) =>
      `${prefix}:${JSON.stringify(
        Object.entries(params).toSorted(([a], [b]) => a.localeCompare(b)),
      )}`,
  ),
  clientRunReport: vi.fn(),
  getConnection: vi.fn(),
  resetBus: vi.fn(),
  recordFree: vi.fn(),
  recordCacheHit: vi.fn(),
  recordCacheMiss: vi.fn(),
  traceCacheDecision: vi.fn(),
}));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: mocks.getCached,
  setCached: mocks.setCached,
  buildCacheKey: mocks.buildCacheKey,
  CACHE_TTL: { researchResult: 86400 },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getConnection },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4Client: () => ({ runReport: mocks.clientRunReport }),
}));
vi.mock("@/server/features/sam/samTraceBus", () => ({
  getSamTraceBus: () => ({
    currentTurnId: () => null,
    startTurn: () => "turn_1",
    push: vi.fn(),
  }),
  resetSamTraceBus: mocks.resetBus,
  traceDirectProviderCall: <T>(_provider: string, execute: () => Promise<T>) =>
    execute(),
}));
vi.mock("@/server/lib/seo-data/cost-tracker", () => ({
  recordFreeProviderCall: mocks.recordFree,
  recordCacheHit: mocks.recordCacheHit,
  recordCacheMiss: mocks.recordCacheMiss,
}));
vi.mock("@/server/lib/seo-data/trace", () => ({
  traceCacheDecision: mocks.traceCacheDecision,
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { clearSingleFlight } from "@/server/lib/seo-data/single-flight";
import { Ga4Service } from "./Ga4Service";
import { GA4_CACHE_TTL_SECONDS } from "@/shared/ga4";

const CONNECTION = {
  id: "c1",
  projectId: "p1",
  organizationId: "o1",
  propertyId: "42",
  connectedByUserId: "u1",
  ga4AccountId: "acc1",
};

const REPORT_REQUEST = {
  propertyId: "42",
  dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
  dimensions: ["date"],
  metrics: ["sessions"],
};

const API_RESULT = {
  rowCount: 1,
  rows: [{ dimensionValues: ["20250101"], metricValues: [12] }],
  metadata: { samplingState: "NOT_SAMPLED", isTruncated: false },
};

describe("Ga4Service report methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCached.mockResolvedValue(null);
    mocks.setCached.mockResolvedValue(undefined);
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.clientRunReport.mockResolvedValue(API_RESULT);
    clearSingleFlight();
  });

  it("resolves the connection through the repository with project+org scoping", async () => {
    mocks.getConnection.mockResolvedValueOnce(null);
    await expect(
      Ga4Service.runReportForConnection({
        projectId: "p1",
        organizationId: "o1",
        request: REPORT_REQUEST,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.getConnection).toHaveBeenCalledWith("p1", "o1");
  });

  it("misses cache, fetches through the client, and stores with 24h TTL", async () => {
    const result = await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual(API_RESULT);
    expect(mocks.clientRunReport).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "42" }),
    );
    expect(mocks.setCached).toHaveBeenCalledWith(
      expect.stringContaining("ga4:report"),
      expect.objectContaining({ rowCount: 1 }),
      GA4_CACHE_TTL_SECONDS,
    );
    expect(mocks.recordFree).toHaveBeenCalledWith("ga4");
  });

  it("returns cached rows without a client call on hit", async () => {
    mocks.getCached.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ dimensionValues: ["20250101"], metricValues: [99] }],
      metadata: { samplingState: "NOT_SAMPLED", isTruncated: false },
    });
    const result = await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    expect(result.fromCache).toBe(true);
    expect(result.data.rows[0].metricValues[0]).toBe(99);
    expect(mocks.clientRunReport).not.toHaveBeenCalled();
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it("treats an unparseable cached payload as a miss", async () => {
    mocks.getCached.mockResolvedValueOnce({ garbage: true });
    const result = await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    expect(result.fromCache).toBe(false);
    expect(mocks.clientRunReport).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent identical misses into one client call", async () => {
    mocks.clientRunReport.mockImplementation(async () =>
      new Promise((resolve) => setTimeout(resolve, 25)).then(() => API_RESULT),
    );
    const input = {
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    };
    const [a, b] = await Promise.all([
      Ga4Service.runReportForConnection(input),
      Ga4Service.runReportForConnection(input),
    ]);
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(false);
    expect(mocks.clientRunReport).toHaveBeenCalledTimes(1);
  });

  it("propagates provider errors instead of returning empty rows", async () => {
    mocks.clientRunReport.mockRejectedValue(new Error("provider down"));
    await expect(
      Ga4Service.runReportForConnection({
        projectId: "p1",
        organizationId: "o1",
        request: REPORT_REQUEST,
      }),
    ).rejects.toThrow("provider down");
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it("uses the connection's property id over the request's", async () => {
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: { ...REPORT_REQUEST, propertyId: "999" },
    });
    expect(mocks.clientRunReport).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "42" }),
    );
  });

  it("caches different requests under different keys", async () => {
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: {
        ...REPORT_REQUEST,
        dateRanges: [{ startDate: "2025-02-01", endDate: "2025-02-07" }],
      },
    });
    const keys = mocks.setCached.mock.calls.map((call) => call[0]);
    expect(new Set(keys).size).toBe(2);
  });

  it("includes the organization id in the cache key like the router convention", async () => {
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    const key = mocks.setCached.mock.calls[0][0];
    expect(key).toContain("ga4:report");
    // The deterministic mock key serializes params — organizationId must be
    // part of them so cross-org requests never share entries.
    expect(mocks.buildCacheKey).toHaveBeenCalledWith(
      "ga4:report",
      expect.objectContaining({ organizationId: "o1" }),
    );
  });

  it("records cache decisions and hit/miss counters like the router seam", async () => {
    mocks.getCached.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ dimensionValues: ["20250101"], metricValues: [7] }],
      metadata: { samplingState: "NOT_SAMPLED", isTruncated: false },
    });
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    expect(mocks.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(mocks.traceCacheDecision).toHaveBeenCalledWith(true);
    expect(mocks.recordCacheMiss).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getConnection.mockResolvedValue(CONNECTION);
    await Ga4Service.runReportForConnection({
      projectId: "p1",
      organizationId: "o1",
      request: REPORT_REQUEST,
    });
    expect(mocks.recordCacheMiss).toHaveBeenCalledTimes(1);
    expect(mocks.traceCacheDecision).toHaveBeenCalledWith(false);
  });
});

describe("Ga4Service.getPeriodUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCached.mockResolvedValue(null);
    mocks.setCached.mockResolvedValue(undefined);
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.clientRunReport.mockResolvedValue({
      rowCount: 1,
      rows: [{ dimensionValues: [], metricValues: [123, 45] }],
      metadata: { samplingState: "NOT_SAMPLED", isTruncated: false },
    });
    clearSingleFlight();
  });

  it("queries exact-period distinct users with asOf freeze", async () => {
    const result = await Ga4Service.getPeriodUsers({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(mocks.clientRunReport).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "42",
        dimensions: [],
        metrics: ["totalUsers", "activeUsers"],
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-31" }],
      }),
    );
    expect(result.data).toEqual({ totalUsers: 123, activeUsers: 45 });
    expect(result.asOf).toEqual(expect.any(String));
    expect(result.fromCache).toBe(false);
  });

  it("caches under the distinct-users key family", async () => {
    await Ga4Service.getPeriodUsers({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(mocks.setCached).toHaveBeenCalledWith(
      expect.stringContaining("ga4:distinct-users"),
      expect.anything(),
      GA4_CACHE_TTL_SECONDS,
    );
  });

  it("serves a cache hit without a client call", async () => {
    mocks.getCached.mockResolvedValueOnce({
      asOf: "2025-01-31T00:00:00.000Z",
      data: { totalUsers: 7, activeUsers: 3 },
    });
    const result = await Ga4Service.getPeriodUsers({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(result.fromCache).toBe(true);
    expect(result.asOf).toBe("2025-01-31T00:00:00.000Z");
    expect(mocks.clientRunReport).not.toHaveBeenCalled();
  });

  it("rejects an unparseable cached payload and refetches", async () => {
    mocks.getCached.mockResolvedValueOnce({ nope: 1 });
    const result = await Ga4Service.getPeriodUsers({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(result.fromCache).toBe(false);
    expect(mocks.clientRunReport).toHaveBeenCalledTimes(1);
  });
});
