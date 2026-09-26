import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccessToken = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getAccessToken } }) }));
import { createGa4Client } from "./ga4Client";

describe("GA4 Admin client", () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("enumerates every account-summary page and normalizes property summaries", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/1",
                propertySummaries: [
                  { property: "properties/42", displayName: "Main property" },
                ],
              },
            ],
            nextPageToken: "next",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accountSummaries: [
              {
                account: "accounts/2",
                propertySummaries: [
                  { property: "properties/84", displayName: "Second property" },
                ],
              },
            ],
          }),
        ),
      );

    await expect(
      createGa4Client({
        userId: "user-1",
        ga4AccountId: "google-sub",
      }).listProperties(),
    ).resolves.toEqual([
      { propertyId: "42", displayName: "Main property", currencyCode: null },
      { propertyId: "84", displayName: "Second property", currencyCode: null },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageToken=next",
      expect.anything(),
    );
  });
});
