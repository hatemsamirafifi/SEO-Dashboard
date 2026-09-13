import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

import {
  classifyGscSyncError,
  normalizeGscRow,
  splitDateRangeIntoChunks,
} from "./GscSyncService";
import {
  GscApiError,
  GscTokenError,
  type GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import { GscNotConnectedError } from "./GscService";

describe("splitDateRangeIntoChunks", () => {
  it("splits a 15-day range into 7-day chunks", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-15", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-07" },
      { startDate: "2026-05-08", endDate: "2026-05-14" },
      { startDate: "2026-05-15", endDate: "2026-05-15" },
    ]);
  });

  it("handles a single day", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-01", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-01" },
    ]);
  });

  it("handles range smaller than chunkDays", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-04", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-04" },
    ]);
  });

  it("returns empty array for invalid or inverted dates", () => {
    expect(splitDateRangeIntoChunks("2026-05-10", "2026-05-01", 7)).toEqual([]);
    expect(splitDateRangeIntoChunks("invalid", "2026-05-01", 7)).toEqual([]);
  });
});

describe("normalizeGscRow", () => {
  const projectId = "proj_123";
  const property = "sc-domain:example.com";

  it("normalizes summary grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01"],
      clicks: 12,
      impressions: 340,
      ctr: 0.035,
      position: 8.4,
    };
    const fact = await normalizeGscRow(raw, "summary", projectId, property);
    expect(fact).not.toBeNull();
    expect(fact?.grain).toBe("summary");
    expect(fact?.date).toBe("2026-05-01");
    expect(fact?.clicks).toBe(12);
    expect(fact?.impressions).toBe(340);
    expect(fact?.query).toBeNull();
    expect(fact?.page).toBeNull();
    expect(fact?.country).toBeNull();
    expect(fact?.device).toBeNull();
  });

  it("normalizes query grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "best coffee maker"],
      clicks: 5,
      impressions: 100,
      ctr: 0.05,
      position: 4.2,
    };
    const fact = await normalizeGscRow(raw, "query", projectId, property);
    expect(fact?.grain).toBe("query");
    expect(fact?.query).toBe("best coffee maker");
    expect(fact?.grainKey).toBe("best coffee maker");
    expect(fact?.page).toBeNull();
  });

  it("normalizes page grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "https://example.com/blog/coffee"],
      clicks: 8,
      impressions: 200,
      ctr: 0.04,
      position: 5.1,
    };
    const fact = await normalizeGscRow(raw, "page", projectId, property);
    expect(fact?.grain).toBe("page");
    expect(fact?.page).toBe("https://example.com/blog/coffee");
    expect(fact?.grainKey).toBe("https://example.com/blog/coffee");
  });

  it("normalizes query_page grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "best coffee maker", "https://example.com/product/1"],
      clicks: 3,
      impressions: 50,
      ctr: 0.06,
      position: 6.0,
    };
    const fact = await normalizeGscRow(raw, "query_page", projectId, property);
    expect(fact?.grain).toBe("query_page");
    expect(fact?.query).toBe("best coffee maker");
    expect(fact?.page).toBe("https://example.com/product/1");
    expect(fact?.grainKey).toBe("best coffee maker::https://example.com/product/1");
  });

  it("normalizes country grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "USA"],
      clicks: 10,
      impressions: 150,
      ctr: 0.066,
      position: 3.5,
    };
    const fact = await normalizeGscRow(raw, "country", projectId, property);
    expect(fact?.grain).toBe("country");
    expect(fact?.country).toBe("usa");
    expect(fact?.grainKey).toBe("usa");
  });

  it("normalizes device grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "mobile"],
      clicks: 7,
      impressions: 120,
      ctr: 0.058,
      position: 5.0,
    };
    const fact = await normalizeGscRow(raw, "device", projectId, property);
    expect(fact?.grain).toBe("device");
    expect(fact?.device).toBe("MOBILE");
    expect(fact?.grainKey).toBe("MOBILE");
  });

  it("returns null when date key is missing or invalid", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: [],
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    };
    expect(await normalizeGscRow(raw, "summary", projectId, property)).toBeNull();
  });
});

describe("classifyGscSyncError", () => {
  it("classifies token errors", () => {
    const err = new GscTokenError("Token revoked");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("OAUTH_TOKEN_FAILURE");
  });

  it("classifies permission denied (401/403)", () => {
    const err = new GscApiError(403, "Forbidden");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("PERMISSION_DENIED");
  });

  it("classifies rate limits (429)", () => {
    const err = new GscApiError(429, "Too Many Requests");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("classifies not connected", () => {
    const err = new GscNotConnectedError("p1");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("NOT_CONNECTED");
  });
});
