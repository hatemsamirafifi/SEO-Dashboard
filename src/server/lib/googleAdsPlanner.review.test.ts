import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

import {
  parseHistoricalPage,
  parseIdeasPage,
} from "./googleAdsPlanner.metrics";
import {
  parseLanguageConstants,
  selectLanguageConstant,
} from "./googleAdsTarget";
import {
  createTestClient,
  CUSTOMER_ID,
  installFetchMock,
  jsonResponse,
} from "./googleAdsPlanner.testFixtures";
import { GoogleAdsMalformedResponseError } from "./googleAdsClient";

/* Protocol review regressions for the Phase 2 Planner boundary.
 *
 * Evidence pinned to the official docs:
 *  - ProtoJSON Format (Presence/default-values, Null values)
 *    https://protobuf.dev/programming-guides/json/
 *    Serializers omit empty repeated fields; a null repeated field behaves
 *    the same as absence. Empty results are protocol structure, not errors.
 *  - language_constant.targetable (v26)
 *    https://developers.google.com/google-ads/api/fields/v26/language_constant
 *    A language Google reports as non-targetable can never be selected into
 *    a plan. A proto3 bool that is omitted serializes as proto false.
 */

let fetchMock = installFetchMock();

describe("Google Ads Planner protocol review regressions", () => {
  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    fetchMock = installFetchMock();
  });

  it("accepts an omitted repeated results field as a successful empty ideas page", () => {
    expect(parseIdeasPage({ totalSize: "0" })).toEqual({
      ok: true,
      value: {
        records: [],
        malformedRecords: 0,
        totalResults: 0,
        nextPageToken: null,
      },
    });
  });

  it("accepts an omitted repeated results field as a successful empty historical response", () => {
    expect(parseHistoricalPage({})).toEqual({
      ok: true,
      value: { records: [], malformedRecords: 0, duplicateRecords: 0 },
    });
  });

  it("treats an explicit null results field like absence, as ProtoJSON does", () => {
    expect(parseIdeasPage({ results: null, totalSize: "0" })).toEqual({
      ok: true,
      value: {
        records: [],
        malformedRecords: 0,
        totalResults: 0,
        nextPageToken: null,
      },
    });
    expect(parseHistoricalPage({ results: null })).toEqual({
      ok: true,
      value: { records: [], malformedRecords: 0, duplicateRecords: 0 },
    });
  });

  it("still rejects a present non-array results field as malformed", () => {
    expect(parseIdeasPage({ totalSize: "0", results: "nope" })).toEqual({
      ok: false,
    });
    expect(parseIdeasPage({ results: 7 })).toEqual({ ok: false });
    expect(parseHistoricalPage({ results: true })).toEqual({ ok: false });
  });

  it("rejects the sole matching language when Google says it cannot be targeted", () => {
    const selected = selectLanguageConstant(
      [
        {
          resourceName: "languageConstants/1000",
          id: "1000",
          code: "en",
          name: "English",
          targetable: false,
        },
      ],
      "en",
    );
    expect(selected.ok).toBe(false);
  });

  it("treats an omitted targetable bool as proto false and rejects it", () => {
    const parsed = parseLanguageConstants({
      results: [
        {
          languageConstant: {
            resourceName: "languageConstants/1000",
            id: "1000",
            code: "en",
            name: "English",
          },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected valid language metadata");
    expect(parsed.value.constants[0].targetable).toBe(false);
    expect(selectLanguageConstant(parsed.value.constants, "en").ok).toBe(false);
  });

  it("selects the sole matching targetable language", () => {
    const targetable = {
      resourceName: "languageConstants/1000",
      id: "1000",
      code: "en",
      name: "English",
      targetable: true,
    };
    const selected = selectLanguageConstant([targetable], "en");
    expect(selected).toEqual({ ok: true, value: targetable });
  });

  it("keeps the ambiguity check: two targetable constants for one code fail", () => {
    const selected = selectLanguageConstant(
      [
        {
          resourceName: "languageConstants/1000",
          id: "1000",
          code: "en",
          name: "English",
          targetable: true,
        },
        {
          resourceName: "languageConstants/9999",
          id: "9999",
          code: "en",
          name: "English International",
          targetable: true,
        },
      ],
      "en",
    );
    expect(selected.ok).toBe(false);
  });

  it("still picks the sole targetable constant when a non-targetable duplicate exists", () => {
    const targetable = {
      resourceName: "languageConstants/1000",
      id: "1000",
      code: "en",
      name: "English",
      targetable: true,
    };
    const selected = selectLanguageConstant(
      [
        {
          resourceName: "languageConstants/31",
          id: "31",
          code: "en",
          name: "English Legacy",
          targetable: false,
        },
        targetable,
      ],
      "en",
    );
    expect(selected).toEqual({ ok: true, value: targetable });
  });

  it("maps an omitted historical results field to all requested keywords as missing, never as zeros", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const result = await createTestClient().generateKeywordHistoricalMetrics({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes", "quantum widget"],
    });
    expect(result.keywords).toEqual([]);
    expect(result.missingKeywords).toEqual(["running shoes", "quantum widget"]);
    expect(result.malformedKeywords).toBe(0);
    expect(result.duplicateKeywords).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("maps a first ideas page without a results field to a complete empty collection", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ totalSize: "0" }));
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed term"],
    });
    expect(result.ideas).toEqual([]);
    expect(result.malformedIdeas).toBe(0);
    expect(result.totalResults).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.partial).toBe(false);
  });

  it("still fails the client call when the boundary sends a non-array results field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: "corrupt" }));
    const thrown = await capture(
      createTestClient().generateKeywordHistoricalMetrics({
        customerId: CUSTOMER_ID,
        keywords: ["running shoes"],
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
  });
});

/** Await a call that must reject and hand back the thrown value. */
async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}
