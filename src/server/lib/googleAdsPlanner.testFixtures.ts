import { vi, type MockedFunction } from "vitest";
import { z } from "zod";

import { createGoogleAdsClient } from "./googleAdsClient";

/** Shared fixtures for the Google Ads Planner test suites. The suites split
 *  across files so each stays inside the repository's max-lines budget. */

export const CUSTOMER_ID = "4897513260";
export const MANAGER_ID = "3216549870";
export const BASE = "https://googleads.googleapis.com/v26";
export const GEO_US = "geoTargetConstants/2840";
export const LANGUAGE_EN = "languageConstants/1000";

const CLIENT_OPTIONS = { userId: "user-1", grantAccountId: "google-account-1" };

export function createTestClient() {
  return createGoogleAdsClient(CLIENT_OPTIONS);
}

/** Installs a fresh fetch stub and returns the typed mock. */
export function installFetchMock(): MockedFunction<typeof fetch> {
  vi.stubGlobal("fetch", vi.fn());
  return vi.mocked(globalThis.fetch);
}

export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** A body that is not JSON: the raw text must never reach a thrown error. */
export function nonJsonResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

/** A v26 keyword idea row exactly as the REST reference documents it. */
export function ideaRow(
  text: string,
  metrics: Record<string, unknown> = {},
  closeVariants: string[] = [],
) {
  return {
    text,
    closeVariants,
    keywordIdeaMetrics: {
      avgMonthlySearches: "81000",
      competition: "MEDIUM",
      competitionIndex: "52",
      averageCpcMicros: "1250000",
      lowTopOfPageBidMicros: "880000",
      highTopOfPageBidMicros: "2400000",
      monthlySearchVolumes: [
        { year: "2026", month: "SEPTEMBER", monthlySearches: "74000" },
        { year: "2026", month: "OCTOBER", monthlySearches: "91000" },
      ],
      ...metrics,
    },
  };
}

/** A v26 historical-metrics row (the metric block key differs). */
export function historicalRow(
  text: string,
  metrics: Record<string, unknown> = {},
  closeVariants: string[] = [],
) {
  return {
    text,
    closeVariants,
    keywordMetrics: {
      avgMonthlySearches: "81000",
      competition: "MEDIUM",
      competitionIndex: "52",
      averageCpcMicros: "1250000",
      lowTopOfPageBidMicros: "880000",
      highTopOfPageBidMicros: "2400000",
      monthlySearchVolumes: [
        { year: "2026", month: "SEPTEMBER", monthlySearches: "74000" },
      ],
      ...metrics,
    },
  };
}

/** Typed view of a recorded fetch call — no unsafe assertions. */
export function callAt(
  fetchMock: MockedFunction<typeof fetch>,
  index: number,
): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  const [input, init] = call;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return { url, init };
}

/** Request headers as a plain object; header names arrive lowercased. */
export function headersOf(
  init: RequestInit | undefined,
): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/** Raw request body as an object: keys stay visible so a forbidden field
 *  (pageSize) cannot be hidden by schema stripping. */
export function bodyRecord(
  init: RequestInit | undefined,
): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(raw);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

/** Await a call that must reject and hand back the thrown value. */
export async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}

/** A canonical Google JSON error body (googleads.googleapis.com). */
export function adsErrorResponse(
  status: number,
  errorCode: Record<string, string>,
) {
  return jsonResponse(
    {
      error: {
        code: status,
        message: "Raw upstream message that must never leak: SECRET-VALUE",
        details: [
          {
            errors: [{ errorCode, message: "Raw ads failure message" }],
          },
        ],
      },
    },
    status,
  );
}
