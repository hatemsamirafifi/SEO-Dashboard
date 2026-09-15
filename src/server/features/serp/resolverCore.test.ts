import { describe, expect, it, vi } from "vitest";
import {
  createSerpResolverFromEntries,
  SerpProvidersUnavailableError,
  type SerpResolverEntry,
} from "./resolverCore";
import { resetProviderCircuitsForTests } from "./circuitBreaker";
import {
  SerpCancelledError,
  SerpProviderError,
  type NormalizedSerpResult,
  type SerpProvider,
  type SerpSearchInput,
} from "./types";

const input: SerpSearchInput = {
  keywordId: "keyword-1",
  keyword: "seo company dubai",
  targetDomain: "example.com",
  location: {
    countryCode: "AE",
    languageCode: "en",
    locationName: "Dubai, Dubai, United Arab Emirates",
  },
  device: "desktop",
  depth: 100,
};

function successProvider(
  id: SerpProvider["id"],
  position: number | null,
): SerpProvider {
  return {
    id,
    supports: () => true,
    search: vi.fn(
      async (searchInput: SerpSearchInput): Promise<NormalizedSerpResult> => ({
        keywordId: searchInput.keywordId,
        keyword: searchInput.keyword,
        position,
        url: position ? "https://example.com" : null,
        title: null,
        domain: position ? "example.com" : null,
        serpFeatures: [],
        provider: id,
        inspectedDepth: searchInput.depth,
        calls: [
          {
            provider: id,
            endpoint: "/search",
            status: "success",
            httpStatus: 200,
            errorCode: null,
            durationMs: 1,
            resultCount: 10,
            requestedDepth: searchInput.depth,
            inspectedDepth: searchInput.depth,
            pagesRequested: 1,
            resultCompleteness: position == null ? "complete" : "target_found",
            dispatched: true,
          },
        ],
      }),
    ),
  };
}

function failedProvider(
  id: SerpProvider["id"],
  deterministic = false,
): SerpProvider {
  return {
    id,
    supports: () => true,
    search: vi.fn(async () => {
      throw new SerpProviderError(
        id,
        "AUTH_FAILED",
        [
          {
            provider: id,
            endpoint: "/search",
            status: "failed",
            httpStatus: 401,
            errorCode: "AUTH_FAILED",
            durationMs: 1,
            resultCount: null,
            requestedDepth: input.depth,
            inspectedDepth: null,
            pagesRequested: 1,
            resultCompleteness: "not_applicable",
            dispatched: true,
          },
        ],
        "failed",
        deterministic,
      );
    }),
  };
}

function insufficientProvider(id: SerpProvider["id"]): SerpProvider {
  return {
    id,
    supports: () => true,
    search: vi.fn(async (searchInput: SerpSearchInput) => {
      throw new SerpProviderError(
        id,
        "INSUFFICIENT_DEPTH",
        [
          {
            provider: id,
            endpoint: "/search",
            status: "insufficient_depth",
            httpStatus: 200,
            errorCode: "INSUFFICIENT_DEPTH",
            durationMs: 1,
            resultCount: 8,
            requestedDepth: searchInput.depth,
            inspectedDepth: 8,
            pagesRequested: 2,
            resultCompleteness: "insufficient_depth",
            dispatched: true,
          },
        ],
        "insufficient depth",
      );
    }),
  };
}

function entries(...providers: SerpProvider[]): SerpResolverEntry[] {
  return providers.map((provider, index) => ({
    provider,
    priority: index + 1,
    enabled: true,
    configured: true,
  }));
}

describe("SERP provider resolver", () => {
  it("stops on DataForSEO success or valid NO_RESULT", async () => {
    resetProviderCircuitsForTests();
    const first = successProvider("dataforseo", null);
    const second = successProvider("serper", 9);
    const third = successProvider("zenserp", 4);
    const secondSearch = vi.mocked(second.search);
    const thirdSearch = vi.mocked(third.search);
    const result = await createSerpResolverFromEntries({
      entries: entries(first, second, third),
    }).search(input);
    expect(result.provider).toBe("dataforseo");
    expect(secondSearch).not.toHaveBeenCalled();
    expect(thirdSearch).not.toHaveBeenCalled();
  });

  it("stops on a valid Serper NO_RESULT without calling Zenserp", async () => {
    resetProviderCircuitsForTests();
    const zenserp = successProvider("zenserp", 4);
    const zenserpSearch = vi.mocked(zenserp.search);
    const result = await createSerpResolverFromEntries({
      entries: entries(
        failedProvider("dataforseo"),
        successProvider("serper", null),
        zenserp,
      ),
    }).search(input);
    expect(result).toMatchObject({ provider: "serper", position: null });
    expect(zenserpSearch).not.toHaveBeenCalled();
  });

  it("fails over in priority order and preserves every actual call", async () => {
    resetProviderCircuitsForTests();
    const result = await createSerpResolverFromEntries({
      entries: entries(
        failedProvider("dataforseo"),
        failedProvider("serper"),
        successProvider("zenserp", 5),
      ),
    }).search(input);
    expect(result.provider).toBe("zenserp");
    expect(result.calls.map((call) => call.provider)).toEqual([
      "dataforseo",
      "serper",
      "zenserp",
    ]);
  });

  it("falls through from Serper insufficient depth to Zenserp", async () => {
    resetProviderCircuitsForTests();
    const result = await createSerpResolverFromEntries({
      entries: entries(
        failedProvider("dataforseo"),
        insufficientProvider("serper"),
        successProvider("zenserp", null),
      ),
    }).search(input);
    expect(result).toMatchObject({ provider: "zenserp", position: null });
    expect(result.calls.map((call) => call.status)).toEqual([
      "failed",
      "insufficient_depth",
      "success",
    ]);
  });

  it("opens deterministic circuits and skips disabled/missing providers", async () => {
    resetProviderCircuitsForTests();
    const broken = failedProvider("dataforseo", true);
    const fallback = successProvider("serper", 2);
    const brokenSearch = vi.mocked(broken.search);
    const fallbackSearch = vi.mocked(fallback.search);
    const resolver = createSerpResolverFromEntries({
      entries: entries(broken, fallback),
      organizationId: "org",
    });
    await resolver.search(input);
    await resolver.search(input);
    expect(brokenSearch).toHaveBeenCalledTimes(1);
    expect(fallbackSearch).toHaveBeenCalledTimes(2);
  });

  it("skips disabled and unconfigured providers without dispatching calls", async () => {
    resetProviderCircuitsForTests();
    const serper = successProvider("serper", 2);
    const zenserp = successProvider("zenserp", 3);
    const serperSearch = vi.mocked(serper.search);
    const result = await createSerpResolverFromEntries({
      entries: [
        {
          provider: failedProvider("dataforseo"),
          priority: 1,
          enabled: true,
          configured: true,
        },
        {
          provider: serper,
          priority: 2,
          enabled: false,
          configured: true,
        },
        {
          provider: zenserp,
          priority: 3,
          enabled: true,
          configured: true,
        },
      ],
    }).search(input);
    expect(result.provider).toBe("zenserp");
    expect(serperSearch).not.toHaveBeenCalled();
    expect(result.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "serper",
          status: "skipped",
          errorCode: "DISABLED",
          dispatched: false,
        }),
      ]),
    );
  });

  it("records unsupported mobile Serper as skipped, not failed", async () => {
    resetProviderCircuitsForTests();
    const serper: SerpProvider = {
      ...successProvider("serper", 2),
      supports: (searchInput) => searchInput.device === "desktop",
    };
    const result = await createSerpResolverFromEntries({
      entries: entries(serper, successProvider("zenserp", 3)),
    }).search({ ...input, device: "mobile" });
    expect(result.provider).toBe("zenserp");
    expect(result.calls[0]).toMatchObject({
      provider: "serper",
      status: "skipped",
      errorCode: "UNSUPPORTED_DEVICE",
      dispatched: false,
    });
  });

  it("checks cancellation again after a provider failure", async () => {
    resetProviderCircuitsForTests();
    const serper = successProvider("serper", 3);
    const serperSearch = vi.mocked(serper.search);
    let checks = 0;
    await expect(
      createSerpResolverFromEntries({
        entries: entries(failedProvider("dataforseo"), serper),
      }).search({
        ...input,
        isCancelled: async () => ++checks > 1,
      }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(serperSearch).not.toHaveBeenCalled();
  });

  it("never falls back after cancellation", async () => {
    const first: SerpProvider = {
      id: "dataforseo",
      supports: () => true,
      search: vi.fn(async () => {
        throw new SerpCancelledError();
      }),
    };
    const fallback = successProvider("serper", 3);
    const fallbackSearch = vi.mocked(fallback.search);
    await expect(
      createSerpResolverFromEntries({
        entries: entries(first, fallback),
      }).search(input),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(fallbackSearch).not.toHaveBeenCalled();
  });

  it("returns CHECK_FAILED evidence when all providers fail", async () => {
    resetProviderCircuitsForTests();
    const error = await createSerpResolverFromEntries({
      entries: entries(
        failedProvider("dataforseo"),
        failedProvider("serper"),
        failedProvider("zenserp"),
      ),
    })
      .search(input)
      .catch((value: unknown) => value);
    expect(error).toHaveProperty("name", "SerpProvidersUnavailableError");
    expect(error).toHaveProperty("calls.length", 3);
  });

  it("returns CHECK_FAILED evidence when every provider is insufficient", async () => {
    resetProviderCircuitsForTests();
    let caught: SerpProvidersUnavailableError | null = null;
    try {
      await createSerpResolverFromEntries({
        entries: entries(
          insufficientProvider("dataforseo"),
          insufficientProvider("serper"),
          insufficientProvider("zenserp"),
        ),
      }).search(input);
    } catch (err) {
      if (err instanceof SerpProvidersUnavailableError) {
        caught = err;
      }
    }
    expect(caught).not.toBeNull();
    if (caught) {
      expect(caught.calls).toHaveLength(3);
      expect(caught.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "insufficient_depth" }),
        ]),
      );
    }
  });
});
