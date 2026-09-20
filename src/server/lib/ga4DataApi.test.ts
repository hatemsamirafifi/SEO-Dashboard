import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccessToken = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getAccessToken } }) }));
import {
  classifyGa4Error,
  createGa4Client,
  Ga4ApiError,
  Ga4RequestError,
  Ga4TokenError,
} from "./ga4Client";

const RUN_REPORT_URL =
  "https://analyticsdata.googleapis.com/v1beta/properties/42:runReport";
const BATCH_URL =
  "https://analyticsdata.googleapis.com/v1beta/properties/42:batchRunReports";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("GA4 Data API client", () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("allowlist", () => {
    it("rejects a non-allowlisted dimension before any HTTP call", async () => {
      const fetchMock = vi.mocked(fetch);
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      await expect(
        client.runReport({
          propertyId: "42",
          dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
          dimensions: ["hostName"],
          metrics: ["sessions"],
        }),
      ).rejects.toBeInstanceOf(Ga4RequestError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a non-allowlisted metric before any HTTP call", async () => {
      const fetchMock = vi.mocked(fetch);
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      await expect(
        client.runReport({
          propertyId: "42",
          dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
          dimensions: ["date"],
          metrics: ["active28DayUsers"],
        }),
      ).rejects.toBeInstanceOf(Ga4RequestError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends an allowlisted request with bearer token and normalization", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          dimensionHeaders: [{ name: "date" }, { name: "eventName" }],
          metricHeaders: [{ name: "sessions" }, { name: "eventCount" }],
          rows: [
            {
              dimensionValues: [{ value: "20250101" }, { value: "click" }],
              metricValues: [{ value: "12" }, { value: "40" }],
            },
          ],
          rowCount: 1,
          metadata: {
            samplingMetadatas: [
              { samplesReadCount: "100", samplingSpaceSize: "1000" },
            ],
          },
        }),
      );
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      const result = await client.runReport({
        propertyId: "42",
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
        dimensions: ["date", "eventName"],
        metrics: ["sessions", "eventCount"],
        limit: 10,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        RUN_REPORT_URL,
        expect.objectContaining({
          method: "POST",
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- test-only vitest matcher
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- mock body typed as RequestInit
      const body = JSON.parse(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unsafe-member-access -- captured fetch init body
        vi.mocked(fetch).mock.calls[0][1]!.body as string,
      ) as Record<string, unknown>;
      expect(body).toEqual({
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
        dimensions: [{ name: "date" }, { name: "eventName" }],
        metrics: [{ name: "sessions" }, { name: "eventCount" }],
        limit: 10,
      });
      expect(result).toEqual({
        rowCount: 1,
        rows: [
          { dimensionValues: ["20250101", "click"], metricValues: [12, 40] },
        ],
        metadata: { samplingState: "SAMPLED", isTruncated: false },
      });
    });
  });

  describe("batchRunReports", () => {
    it("sends all sub-requests in one HTTP call and maps responses by index", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          reports: [
            { rowCount: 2, rows: [] },
            { rowCount: 5, rows: [] },
          ],
        }),
      );
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      const base = {
        propertyId: "42",
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
      };
      const results = await client.batchRunReports([
        { ...base, dimensions: ["date"], metrics: ["sessions"] },
        {
          ...base,
          dimensions: ["sessionDefaultChannelGroup"],
          metrics: ["sessions"],
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(BATCH_URL, expect.anything());
      expect(results).toEqual([
        expect.objectContaining({ rowCount: 2 }),
        expect.objectContaining({ rowCount: 5 }),
      ]);
    });

    it("rejects the whole batch if any sub-request is non-allowlisted", async () => {
      const fetchMock = vi.mocked(fetch);
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      const base = {
        propertyId: "42",
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
      };
      await expect(
        client.batchRunReports([
          { ...base, dimensions: ["date"], metrics: ["sessions"] },
          { ...base, dimensions: ["secretDim"], metrics: ["sessions"] },
        ]),
      ).rejects.toBeInstanceOf(Ga4RequestError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps per-report errors to the failing index only", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          reports: [
            { rowCount: 2, rows: [] },
            {
              error: {
                code: 400,
                message: "Invalid dimension",
                status: "INVALID_ARGUMENT",
              },
            },
          ],
        }),
      );
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      const base = {
        propertyId: "42",
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
      };
      const results = await client.batchRunReports([
        { ...base, dimensions: ["date"], metrics: ["sessions"] },
        { ...base, dimensions: ["eventName"], metrics: ["sessions"] },
      ]);
      expect(results[0]).toEqual(expect.objectContaining({ rowCount: 2 }));
      expect(results[1]).toBeInstanceOf(Ga4ApiError);
    });
  });

  describe("classifyGa4Error taxonomy", () => {
    it("classifies token failures", () => {
      const c = classifyGa4Error(
        new Ga4TokenError("Could not mint a Google Analytics access token"),
      );
      expect(c).toEqual({
        errorClass: "OAUTH_TOKEN_FAILURE",
        message: "Could not mint a Google Analytics access token",
        retryable: false,
      });
    });

    it("classifies 401/403 as PERMISSION_DENIED", () => {
      expect(classifyGa4Error(new Ga4ApiError(403, "denied"))).toEqual({
        errorClass: "PERMISSION_DENIED",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- test-only vitest matcher
        message: expect.any(String),
        retryable: false,
      });
    });

    it("classifies 404 as PROPERTY_NOT_FOUND", () => {
      expect(classifyGa4Error(new Ga4ApiError(404, "gone"))).toEqual({
        errorClass: "PROPERTY_NOT_FOUND",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- test-only vitest matcher
        message: expect.any(String),
        retryable: false,
      });
    });

    it("classifies HTTP 429 as QUOTA_EXHAUSTED", () => {
      const c = classifyGa4Error(new Ga4ApiError(429, "quota"));
      expect(c.errorClass).toBe("QUOTA_EXHAUSTED");
      expect(c.retryable).toBe(true);
    });

    it("classifies API status 8 RESOURCE_EXHAUSTED as QUOTA_EXHAUSTED", () => {
      const c = classifyGa4Error(new Ga4ApiError(429, "Resource exhausted", 8));
      expect(c.errorClass).toBe("QUOTA_EXHAUSTED");
      expect(c.retryable).toBe(true);
    });

    it("classifies 400 as INVALID_REQUEST", () => {
      expect(classifyGa4Error(new Ga4ApiError(400, "bad"))).toEqual({
        errorClass: "INVALID_REQUEST",
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- test-only vitest matcher
        message: expect.any(String),
        retryable: false,
      });
    });

    it("classifies 500 as retryable HTTP_ERROR_500", () => {
      const c = classifyGa4Error(new Ga4ApiError(500, "boom"));
      expect(c.errorClass).toBe("HTTP_ERROR_500");
      expect(c.retryable).toBe(true);
    });

    it("classifies unknown errors as SYNC_FAILURE", () => {
      expect(classifyGa4Error(new Error("weird"))).toEqual({
        errorClass: "SYNC_FAILURE",
        message: "weird",
        retryable: false,
      });
    });
  });

  describe("api error construction from responses", () => {
    it("captures api status code from RESOURCE_EXHAUSTED body", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 429,
              message: "RESOURCE_EXHAUSTED",
              status: "RESOURCE_EXHAUSTED",
            },
          },
          429,
        ),
      );
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      const promise = client.runReport({
        propertyId: "42",
        dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
        dimensions: ["date"],
        metrics: ["sessions"],
      });
      await expect(promise).rejects.toBeInstanceOf(Ga4ApiError);
      const caught = await promise.catch((e: unknown) => e);
      if (!(caught instanceof Ga4ApiError)) throw new Error("not Ga4ApiError");
      expect(caught.status).toBe(429);
      expect(caught.apiStatus).toBe(8);
      expect(classifyGa4Error(caught).errorClass).toBe("QUOTA_EXHAUSTED");
    });

    it("rejects a malformed success payload", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          rows: [{ dimensionValues: [{ value: 42 }] }],
        }),
      );
      const client = createGa4Client({ userId: "u", ga4AccountId: "a" });
      await expect(
        client.runReport({
          propertyId: "42",
          dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-07" }],
          dimensions: ["date"],
          metrics: ["sessions"],
        }),
      ).rejects.toThrow();
    });
  });
});
