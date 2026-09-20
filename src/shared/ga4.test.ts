import { describe, expect, it } from "vitest";
import { GA4_OAUTH_PROVIDER_ID, GA4_OAUTH_SCOPES } from "./ga4";

describe("GA4 OAuth contract", () => {
  it("requests only the distinct read-only Analytics grant", () => {
    expect(GA4_OAUTH_PROVIDER_ID).toBe("google-analytics");
    expect(GA4_OAUTH_SCOPES).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/analytics.readonly",
    ]);
  });
});
