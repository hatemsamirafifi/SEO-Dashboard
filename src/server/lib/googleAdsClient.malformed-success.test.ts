import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

import {
  classifyGoogleAdsError,
  createGoogleAdsClient,
  GoogleAdsApiError,
  GoogleAdsMalformedResponseError,
} from "./googleAdsClient";

type AdsClient = ReturnType<typeof createGoogleAdsClient>;
const reads = [
  {
    name: "accessible customers",
    read: (client: AdsClient) => client.listAccessibleCustomers(),
  },
  {
    name: "customer",
    read: (client: AdsClient) => client.getCustomer("1234567890"),
  },
  {
    name: "hierarchy",
    read: (client: AdsClient) => client.listCustomerHierarchy("1234567890"),
  },
];

/** A body that is not JSON: the raw text must never reach a thrown error. */
function nonJsonResponse(status: number) {
  return new Response("SECRET-RAW-PAYLOAD", {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function createClient() {
  return createGoogleAdsClient({
    userId: "fixture-user",
    grantAccountId: "fixture-google-sub",
  });
}

/** Await a call that must reject and hand back the thrown value. */
async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}

describe("Google Ads malformed successful response redaction", () => {
  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "fixture-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(nonJsonResponse(200))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(reads)("sanitizes non-JSON success for $name", async ({ read }) => {
    const thrown = await capture(read(createClient()));
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
    if (!(thrown instanceof Error))
      throw new Error("Expected a provider response error");
    expect(thrown.message).not.toContain("SECRET-RAW-PAYLOAD");
    expect(thrown.message).not.toContain("SECRET");
    // The raw parse error quotes the response bytes in its message AND its
    // stack, so neither may carry the payload.
    expect(String(thrown.stack)).not.toContain("SECRET");
    expect(classifyGoogleAdsError(thrown)).toMatchObject({
      errorClass: "MALFORMED_RESPONSE",
      retryable: false,
    });
    expect(classifyGoogleAdsError(thrown).message).not.toContain("SECRET");
  });

  it("still reports the original HTTP status when an error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(nonJsonResponse(502))),
    );
    const thrown = await capture(createClient().listAccessibleCustomers());
    expect(thrown).toBeInstanceOf(GoogleAdsApiError);
    if (!(thrown instanceof GoogleAdsApiError))
      throw new Error("Expected an API error");
    expect(thrown.status).toBe(502);
    expect(thrown.googleAdsErrorCode).toBeUndefined();
    expect(thrown.message).not.toContain("SECRET");
    expect(String(thrown.stack)).not.toContain("SECRET");
    expect(classifyGoogleAdsError(thrown)).toMatchObject({
      errorClass: "HTTP_ERROR_502",
      retryable: true,
    });
  });
});
