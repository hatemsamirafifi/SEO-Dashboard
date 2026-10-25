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
  GoogleAdsApiError,
  GoogleAdsMalformedResponseError,
  GoogleAdsTokenError,
  classifyGoogleAdsError,
  createGoogleAdsClient,
} from "./googleAdsClient";

/* Realistic customer IDs (the API issues ten-digit values; the old fake
 * short/"page-N" fixtures never exercised the strict contract). */
const MANAGER_ID = "3216549870";
const DIRECT_CUSTOMER_ID = "4897513260";
const CLIENT_A_ID = "2349871650";
const CLIENT_B_ID = "1567432098";
const BASE = "https://googleads.googleapis.com/v26";

let fetchMock: MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** A v26 REST `googleAds:search` result row, shaped exactly as documented
 *  (lowerCamelCase resource JSON). */
function customerRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      resourceName: `customers/${id}`,
      id,
      descriptiveName: "Client store",
      currencyCode: "USD",
      timeZone: "America/New_York",
      manager: false,
      testAccount: false,
      status: "ENABLED",
      ...overrides,
    },
  };
}

function customerClientRow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    customerClient: {
      resourceName: `customers/${MANAGER_ID}/customerClients/${id}`,
      clientCustomer: `customers/${id}`,
      id,
      level: 1,
      hidden: false,
      manager: false,
      ...overrides,
    },
  };
}

/** A v26 search payload: result rows plus an optional page token. */
function searchResponse(results: unknown[], nextPageToken?: string) {
  return jsonResponse({ results, ...(nextPageToken ? { nextPageToken } : {}) });
}

/** Accessible-customers payload for the given customer ids. */
function listResponse(...ids: string[]) {
  return jsonResponse({ resourceNames: ids.map((id) => `customers/${id}`) });
}

/** Canonical Google JSON error body (googleads.googleapis.com). */
function adsErrorResponse(status: number, errorCode?: Record<string, string>) {
  return jsonResponse(
    {
      error: {
        code: status,
        message: "Raw upstream message that must never leak: SECRET-VALUE",
        details: [
          {
            "@type":
              "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: [
              {
                errorCode,
                message: "Raw ads failure message that must never leak",
                trigger: "TRIGGER-VALUE",
              },
            ],
            requestId: "pipeline-yb7mCEUYxcIgkD3xAIdrjQ",
          },
        ],
      },
    },
    status,
  );
}

const CLIENT_OPTIONS = { userId: "user-1", grantAccountId: "google-account-1" };
const client = () => createGoogleAdsClient(CLIENT_OPTIONS);

/** Typed view of a recorded fetch call — no unsafe assertions. */
function callAt(index: number): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  const [input, init] = call;
  return { url: requestUrl(input), init };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Request headers as a plain object; header names arrive lowercased. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/** Raw request body as an object: keys stay visible so a forbidden field
 *  (pageSize) cannot be hidden by schema stripping. */
function bodyRecord(init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(raw);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

/** Await a call that must reject and hand back the thrown value. */
async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}

/** Await a call that must reject with a GoogleAdsApiError and narrow it. */
async function captureApiError(
  call: Promise<unknown>,
): Promise<GoogleAdsApiError> {
  const thrown = await capture(call);
  expect(thrown).toBeInstanceOf(GoogleAdsApiError);
  if (!(thrown instanceof GoogleAdsApiError)) {
    throw new Error("expected a GoogleAdsApiError");
  }
  return thrown;
}

describe("Google Ads v26 REST client", () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn());
    fetchMock = vi.mocked(fetch);
  });

  it("lists accessible customers via GET /v26/customers:listAccessibleCustomers", async () => {
    fetchMock.mockResolvedValueOnce(
      listResponse(DIRECT_CUSTOMER_ID, MANAGER_ID),
    );
    const customerIds = await client().listAccessibleCustomers();
    expect(customerIds).toEqual([DIRECT_CUSTOMER_ID, MANAGER_ID]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = callAt(0);
    expect(url).toBe(`${BASE}/customers:listAccessibleCustomers`);
    expect(init).toMatchObject({ method: "GET" });
    expect(headersOf(init)).toMatchObject({
      authorization: "Bearer test-token",
    });
  });

  it("rejects a malformed customer id before any fetch is made", async () => {
    const ads = client();
    for (const invalidId of ["123", "123abc9056", "123-456-789!"]) {
      await expect(ads.getCustomer(invalidId)).rejects.toMatchObject({
        name: "GoogleAdsRequestError",
      });
    }
    // Separated ten digits are accepted and normalized server-side.
    fetchMock.mockResolvedValueOnce(
      searchResponse([customerRow("1234567890")]),
    );
    await ads.getCustomer("123-456-7890");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callAt(0).url).toContain(
      "/v26/customers/1234567890/googleAds:search",
    );
  });

  it("fetches a single customer with the fixed v26 GAQL customer query and NO pageSize field", async () => {
    fetchMock.mockResolvedValueOnce(
      searchResponse([customerRow(DIRECT_CUSTOMER_ID)]),
    );
    const ads = client();
    await expect(ads.getCustomer(DIRECT_CUSTOMER_ID)).resolves.toMatchObject({
      customerId: DIRECT_CUSTOMER_ID,
      displayName: "Client store",
      currencyCode: "USD",
      timeZone: "America/New_York",
      manager: false,
      isTestAccount: false,
      status: "ENABLED",
    });
    const { url, init } = callAt(0);
    expect(url).toBe(
      `${BASE}/customers/${DIRECT_CUSTOMER_ID}/googleAds:search`,
    );
    expect(init).toMatchObject({ method: "POST" });
    const body = bodyRecord(init);
    // v26 REST contract: query + optional pageToken only. pageSize is
    // deprecated and rejected with PAGE_SIZE_NOT_SUPPORTED.
    expect(Object.keys(body)).toEqual(["query"]);
    expect(body).not.toHaveProperty("pageSize");
    expect(body).not.toHaveProperty("page_size");
    expect(body.query).toContain("FROM customer");
    expect(body.query).toContain("customer.currency_code");
    expect(body.query).not.toContain("FROM campaign");
    const headers = headersOf(init);
    expect(headers["login-customer-id"]).toBeUndefined();
    expect(headers["developer-token"]).toBeUndefined();
  });

  it("sends the login-customer-id header when acting through a manager", async () => {
    fetchMock.mockResolvedValueOnce(searchResponse([customerRow(CLIENT_A_ID)]));
    const ads = client();
    await ads.getCustomer(CLIENT_A_ID, { loginCustomerId: MANAGER_ID });
    expect(headersOf(callAt(0).init)).toMatchObject({
      "login-customer-id": MANAGER_ID,
    });
  });

  it("flattens the manager hierarchy (camelCase rows), normalizes int64 string levels, and follows page tokens", async () => {
    const rows = [
      customerClientRow(CLIENT_A_ID, { level: "1" }),
      customerClientRow(CLIENT_B_ID, { level: 2 }),
    ];
    fetchMock
      .mockResolvedValueOnce(searchResponse(rows, "tok-2"))
      .mockResolvedValueOnce(
        searchResponse([customerClientRow(CLIENT_B_ID, { level: 2 })]),
      );
    const hierarchy = await client().listCustomerHierarchy(MANAGER_ID, {
      loginCustomerId: MANAGER_ID,
    });
    expect(hierarchy.truncated).toBe(false);
    expect(hierarchy.partial).toBe(false);
    expect(hierarchy.malformedRows).toBe(0);
    expect(hierarchy.entries).toHaveLength(3);
    expect(hierarchy.entries[0]).toMatchObject({
      customerId: CLIENT_A_ID,
      managerId: MANAGER_ID,
      level: 1,
      manager: false,
      hidden: false,
    });
    expect(hierarchy.entries[2]).toMatchObject({
      customerId: CLIENT_B_ID,
      level: 2,
    });
    const secondCallBody = bodyRecord(callAt(1).init);
    expect(secondCallBody.pageToken).toBe("tok-2");
    expect(secondCallBody).not.toHaveProperty("pageSize");
    expect(secondCallBody.query).toContain("FROM customer_client");
    expect(headersOf(callAt(0).init)["login-customer-id"]).toBe(MANAGER_ID);
  });

  it("bounds hierarchy pagination and signals truncated result instead of paging without limit", async () => {
    // Always returns a nextPageToken — traversal must stop at the page cap
    // (no infinite loop, no unbounded spend) and flag the incompleteness.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        searchResponse(
          [customerClientRow("1084765320")],
          `tok-${fetchMock.mock.calls.length}`,
        ),
      ),
    );
    const hierarchy = await client().listCustomerHierarchy(MANAGER_ID);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
    expect(hierarchy.truncated).toBe(true);
    expect(hierarchy.partial).toBe(true);
    expect(hierarchy.entries.length).toBe(fetchMock.mock.calls.length);
  });

  it("stops a repeated page token instead of replaying the same page", async () => {
    // The upstream keeps handing back the same token: the traversal must
    // detect it before requesting that page again.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        searchResponse([customerClientRow(CLIENT_A_ID)], "tok-loop"),
      ),
    );
    const hierarchy = await client().listCustomerHierarchy(MANAGER_ID);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(hierarchy.truncated).toBe(true);
    expect(hierarchy.partial).toBe(true);
    expect(hierarchy.entries).toHaveLength(2);
    expect(bodyRecord(callAt(1).init).pageToken).toBe("tok-loop");
  });

  it("counts malformed hierarchy rows and reports the hierarchy as partial", async () => {
    fetchMock.mockResolvedValueOnce(
      searchResponse([
        customerClientRow(CLIENT_A_ID),
        { customerClient: { id: "12", level: 1 } },
        { customerClient: { id: CLIENT_B_ID, level: "not-a-level" } },
      ]),
    );
    const hierarchy = await client().listCustomerHierarchy(MANAGER_ID);
    expect(hierarchy.entries).toHaveLength(1);
    expect(hierarchy.entries[0]).toMatchObject({ customerId: CLIENT_A_ID });
    expect(hierarchy.malformedRows).toBe(2);
    expect(hierarchy.truncated).toBe(false);
    expect(hierarchy.partial).toBe(true);
  });

  it("treats an empty accessible-customers result as success (not failure)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const customerIds = await client().listAccessibleCustomers();
    expect(customerIds).toEqual([]);
  });

  it("rejects malformed successful payloads with a bounded, secret-free error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        searchResponse([
          customerRow(DIRECT_CUSTOMER_ID, { id: "SECRET-CUSTOMER-ID" }),
        ]),
      )
      .mockResolvedValueOnce(searchResponse([{ id: DIRECT_CUSTOMER_ID }]))
      .mockResolvedValueOnce(
        jsonResponse({ resourceNames: ["customers/SECRET-ID"] }),
      );
    const ads = client();
    const badRow = await capture(ads.getCustomer(DIRECT_CUSTOMER_ID));
    expect(badRow).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(JSON.stringify(badRow)).not.toContain("SECRET");
    expect(classifyGoogleAdsError(badRow).message).not.toContain("SECRET");
    const flatRow = await capture(ads.getCustomer(DIRECT_CUSTOMER_ID));
    expect(flatRow).toBeInstanceOf(GoogleAdsMalformedResponseError);
    const badList = await capture(ads.listAccessibleCustomers());
    expect(badList).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(JSON.stringify(badList)).not.toContain("SECRET");
  });

  it("sanitizes upstream error bodies (raw body, token and request id never leak)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        adsErrorResponse(403, {
          authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
        }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(400, {
          authorizationError: "bogus; DROP TABLE customers--",
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html>gateway error SECRET-BLOB</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      );
    const ads = client();
    const forbidden = await captureApiError(ads.listAccessibleCustomers());
    expect(forbidden.status).toBe(403);
    expect(forbidden.googleAdsErrorCode).toBe(
      "AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
    );
    const serialized = JSON.stringify(forbidden.message);
    expect(serialized).not.toContain("SECRET-VALUE");
    expect(serialized).not.toContain("Raw upstream");
    expect(serialized).not.toContain("Raw ads failure");
    expect(serialized).not.toContain("TRIGGER-VALUE");
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("pipeline-yb7mCEUYxcIgkD3xAIdrjQ");
    // Untrusted errorCode text and non-JSON bodies never reach the caller.
    const untrusted = await captureApiError(ads.listAccessibleCustomers());
    expect(untrusted.googleAdsErrorCode).toBeUndefined();
    const html = await captureApiError(ads.listAccessibleCustomers());
    expect(JSON.stringify(html)).not.toContain("SECRET-BLOB");
    expect(html.googleAdsErrorCode).toBeUndefined();
    // Cloud project restrictions are distinct from account permissions.
    expect(classifyGoogleAdsError(forbidden).errorClass).toBe(
      "API_ACCESS_RESTRICTED",
    );
    expect(classifyGoogleAdsError(forbidden).retryable).toBe(false);
  });

  it("classifies quota exhaustion (persistent vs temporary), transient 5xx and account permission failures", async () => {
    const quota = { quotaError: "RESOURCE_EXHAUSTED" };
    const temporary = { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" };
    const denied = { authorizationError: "USER_PERMISSION_DENIED" };
    const cases: Array<[Response, string, boolean]> = [
      [adsErrorResponse(429, quota), "QUOTA_EXHAUSTED", false],
      [adsErrorResponse(429, temporary), "QUOTA_TEMPORARILY_EXHAUSTED", true],
      [adsErrorResponse(503, {}), "HTTP_ERROR_503", true],
      [adsErrorResponse(403, denied), "PERMISSION_DENIED", false],
    ];
    for (const [response, errorClass, retryable] of cases) {
      fetchMock.mockResolvedValueOnce(response);
      const classified = classifyGoogleAdsError(
        await captureApiError(client().listAccessibleCustomers()),
      );
      expect(classified.errorClass).toBe(errorClass);
      expect(classified.retryable).toBe(retryable);
    }
  });

  it("classifies invalid, expired, revoked and disabled OAuth tokens as needing a reconnect", async () => {
    const oauthErrors = [
      "OAUTH_TOKEN_INVALID",
      "OAUTH_TOKEN_EXPIRED",
      "OAUTH_TOKEN_REVOKED",
      "OAUTH_TOKEN_DISABLED",
    ];
    for (const oauthError of oauthErrors) {
      fetchMock.mockResolvedValueOnce(
        adsErrorResponse(401, { authenticationError: oauthError }),
      );
      const thrown = await capture(client().getCustomer(DIRECT_CUSTOMER_ID));
      const classified = classifyGoogleAdsError(thrown);
      expect(classified.errorClass).toBe("OAUTH_TOKEN_INVALID");
      expect(classified.retryable).toBe(false);
      expect(classified.message).toContain("Reconnect");
    }
  });

  it("throws a token error when no access token can be minted and needs a reconnect", async () => {
    getAccessToken.mockRejectedValueOnce(
      new Error("upstream revocation they should not see"),
    );
    const ads = client();
    const thrown = await capture(ads.listAccessibleCustomers());
    expect(thrown).toBeInstanceOf(GoogleAdsTokenError);
    expect(classifyGoogleAdsError(thrown).errorClass).toBe(
      "OAUTH_TOKEN_FAILURE",
    );
    expect(classifyGoogleAdsError(thrown).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
