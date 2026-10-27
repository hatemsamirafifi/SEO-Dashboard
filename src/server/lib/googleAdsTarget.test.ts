import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import { z } from "zod";

const getAccessToken = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getAccessToken } }) }));

import {
  classifyGoogleAdsError,
  createGoogleAdsClient,
  GoogleAdsMalformedResponseError,
  GoogleAdsRequestError,
} from "./googleAdsClient";

/* Phase 2 — verified geo / language targeting resolution.
 *
 * Contracts pinned to the official v26 reference:
 *  - POST /v26/geoTargetConstants:suggest
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/SuggestGeoTargetConstantsRequest
 *  - GeoTargetConstant (status + target type + ISO country code)
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GeoTargetConstant
 *  - language_constant fields
 *    https://developers.google.com/google-ads/api/fields/v26/language_constant
 */

const CUSTOMER_ID = "4897513260";
const MANAGER_ID = "3216549870";
const BASE = "https://googleads.googleapis.com/v26";

let fetchMock: MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** A v26 geo target constant suggestion. `targetType` uses the officially
 *  published "Target Type" value for a country ("Country"). */
function geoSuggestion(
  overrides: Record<string, unknown> = {},
  constantOverrides: Record<string, unknown> = {},
) {
  return {
    geoTargetConstant: {
      id: "2840",
      name: "United States",
      canonicalName: "United States",
      parentGeoTarget: "",
      status: "ENABLED",
      targetType: "Country",
      resourceName: "geoTargetConstants/2840",
      countryCode: "US",
      ...constantOverrides,
    },
    searchTerm: "United States",
    locale: "en",
    ...overrides,
  };
}

const CLIENT_OPTIONS = { userId: "user-1", grantAccountId: "google-account-1" };
const client = () => createGoogleAdsClient(CLIENT_OPTIONS);

function callAt(index: number): { url: string; init: RequestInit | undefined } {
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

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function bodyRecord(init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(raw);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}

describe("Google Ads v26 geo and language targeting resolution", () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn());
    fetchMock = vi.mocked(fetch);
  });

  it("suggests geo target constants over the v26 geoTargetConstants:suggest contract", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ geoTargetConstantSuggestions: [geoSuggestion()] }),
    );
    const constants = await client().suggestGeoTargetConstants({
      countryCode: "us",
      countryName: "United States",
    });

    const { url, init } = callAt(0);
    expect(url).toBe(`${BASE}/geoTargetConstants:suggest`);
    expect(init).toMatchObject({ method: "POST" });
    expect(headersOf(init)).toMatchObject({
      authorization: "Bearer test-token",
    });
    expect(bodyRecord(init)).toEqual({
      countryCode: "US",
      locationNames: { names: ["United States"] },
    });

    expect(constants).toHaveLength(1);
    expect(constants[0]).toMatchObject({
      resourceName: "geoTargetConstants/2840",
      id: "2840",
      name: "United States",
      countryCode: "US",
      targetType: "COUNTRY",
      status: "ENABLED",
    });
  });

  it("rejects an invalid country code or country name before any fetch", async () => {
    const ads = client();
    for (const input of [
      { countryCode: "USA", countryName: "United States" },
      { countryCode: "U", countryName: "United States" },
      { countryCode: "", countryName: "United States" },
      { countryCode: "US", countryName: "" },
      { countryCode: "US", countryName: "x".repeat(301) },
    ]) {
      const thrown = await capture(ads.suggestGeoTargetConstants(input));
      expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a unique enabled country constant to its resource name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ geoTargetConstantSuggestions: [geoSuggestion()] }),
    );
    const resolved = await client().resolveCountryGeoTargetConstant({
      countryCode: "US",
      countryName: "United States",
    });
    expect(resolved.resourceName).toBe("geoTargetConstants/2840");
    expect(resolved.status).toBe("ENABLED");
  });

  it("accepts the upper-case country target type spelling too", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        geoTargetConstantSuggestions: [
          geoSuggestion({}, { targetType: "COUNTRY" }),
        ],
      }),
    );
    const resolved = await client().resolveCountryGeoTargetConstant({
      countryCode: "US",
      countryName: "United States",
    });
    expect(resolved.targetType).toBe("COUNTRY");
  });

  it("rejects an unknown country instead of returning a wrong constant", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const thrown = await capture(
      client().resolveCountryGeoTargetConstant({
        countryCode: "US",
        countryName: "Neverland",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(String(thrown)).not.toContain("SECRET");
  });

  it("rejects an ambiguous country match explicitly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        geoTargetConstantSuggestions: [
          geoSuggestion(
            {},
            { id: "2840", resourceName: "geoTargetConstants/2840" },
          ),
          geoSuggestion(
            {},
            { id: "2841", resourceName: "geoTargetConstants/2841" },
          ),
        ],
      }),
    );
    const thrown = await capture(
      client().resolveCountryGeoTargetConstant({
        countryCode: "US",
        countryName: "United States",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(String(thrown)).toMatch(/more than one/i);
  });

  it("rejects a country constant that is not enabled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        geoTargetConstantSuggestions: [
          geoSuggestion({}, { status: "REMOVAL_PLANNED" }),
        ],
      }),
    );
    const thrown = await capture(
      client().resolveCountryGeoTargetConstant({
        countryCode: "US",
        countryName: "United States",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
  });

  it("rejects a suggestion whose country code does not match the request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        geoTargetConstantSuggestions: [
          geoSuggestion({}, { countryCode: "CA" }),
        ],
      }),
    );
    const thrown = await capture(
      client().resolveCountryGeoTargetConstant({
        countryCode: "US",
        countryName: "United States",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
  });

  it("rejects a malformed geo target payload without leaking the raw body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("SECRET-GEO-PAYLOAD", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
        ),
      ),
    );
    const thrown = await capture(
      client().resolveCountryGeoTargetConstant({
        countryCode: "US",
        countryName: "United States",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(String(thrown)).not.toContain("SECRET");
    expect(classifyGoogleAdsError(thrown).message).not.toContain("SECRET");
  });

  it("resolves a language constant with a fixed validated language-code search", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            languageConstant: {
              id: "1000",
              code: "es",
              name: "Spanish",
              targetable: true,
              resourceName: "languageConstants/1000",
            },
          },
        ],
      }),
    );
    const resolved = await client().resolveLanguageConstant({
      customerId: CUSTOMER_ID,
      languageCode: "es",
    });

    const { url, init } = callAt(0);
    expect(url).toBe(`${BASE}/customers/${CUSTOMER_ID}/googleAds:search`);
    expect(init).toMatchObject({ method: "POST" });
    const body = bodyRecord(init);
    expect(body.query).toContain("FROM language_constant");
    expect(body.query).toContain("language_constant.code = 'es'");
    // The Search endpoint takes no pageSize and no pageToken.
    expect(Object.keys(body)).toEqual(["query"]);
    expect(headersOf(init)["login-customer-id"]).toBeUndefined();

    expect(resolved).toEqual({
      resourceName: "languageConstants/1000",
      id: "1000",
      code: "es",
      name: "Spanish",
      targetable: true,
    });
  });

  it("sends the authorized login customer header for the language lookup when asked", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            languageConstant: {
              id: "1000",
              code: "es",
              name: "Spanish",
              targetable: true,
              resourceName: "languageConstants/1000",
            },
          },
        ],
      }),
    );
    await client().resolveLanguageConstant({
      customerId: CUSTOMER_ID,
      languageCode: "es",
      loginCustomerId: MANAGER_ID,
    });
    expect(headersOf(callAt(0).init)["login-customer-id"]).toBe(MANAGER_ID);
  });

  it("rejects an unsupported language code before any fetch and never defaults to English", async () => {
    const ads = client();
    for (const languageCode of ["", "e", "english", "en'; DROP", "en US"]) {
      const thrown = await capture(
        ads.resolveLanguageConstant({
          customerId: CUSTOMER_ID,
          languageCode,
        }),
      );
      expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown language constant instead of defaulting to English", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    const thrown = await capture(
      client().resolveLanguageConstant({
        customerId: CUSTOMER_ID,
        languageCode: "zz",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(String(thrown)).not.toMatch(/english/i);
  });

  it("rejects an ambiguous language constant explicitly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            languageConstant: {
              id: "1000",
              code: "en",
              name: "English",
              targetable: true,
              resourceName: "languageConstants/1000",
            },
          },
          {
            languageConstant: {
              id: "1001",
              code: "en",
              name: "English (Canada)",
              targetable: true,
              resourceName: "languageConstants/1001",
            },
          },
        ],
      }),
    );
    const thrown = await capture(
      client().resolveLanguageConstant({
        customerId: CUSTOMER_ID,
        languageCode: "en",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(String(thrown)).toMatch(/more than one/i);
  });

  it("rejects a malformed language constant payload without leaking the raw body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("SECRET-LANGUAGE-PAYLOAD", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
        ),
      ),
    );
    const thrown = await capture(
      client().resolveLanguageConstant({
        customerId: CUSTOMER_ID,
        languageCode: "es",
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(String(thrown)).not.toContain("SECRET");
  });
});
