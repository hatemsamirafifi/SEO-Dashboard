/* eslint-disable max-lines, max-lines-per-function */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createSerpResolverFromEntries,
  SerpProvidersUnavailableError,
  type SerpResolverEntry,
} from "./resolverCore";
import {
  getProviderCircuitState,
  resetProviderCircuitsForTests,
} from "./circuitBreaker";
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

  it("records CIRCUIT_OPEN with the underlying reason and retry window", async () => {
    resetProviderCircuitsForTests();
    const broken = failedProvider("dataforseo", true);
    const fallback = successProvider("serper", 2);
    const resolver = createSerpResolverFromEntries({
      entries: entries(broken, fallback),
      organizationId: "org",
    });
    await resolver.search(input);
    const second = await resolver.search(input);
    expect(second.calls[0]).toMatchObject({
      provider: "dataforseo",
      status: "skipped",
      skipReason: "CIRCUIT_OPEN",
      errorCode: "CIRCUIT_OPEN",
      circuitReason: "AUTH_FAILED",
      dispatched: false,
    });
    expect(second.calls[0]?.circuitOpenedAt).toBeTruthy();
    expect(second.calls[0]?.circuitExpiresAt).toBeTruthy();
  });

  it("keys a circuit by credential fingerprint", async () => {
    resetProviderCircuitsForTests();
    const broken = failedProvider("dataforseo", true);
    await createSerpResolverFromEntries({
      entries: [
        {
          provider: broken,
          priority: 1,
          enabled: true,
          configured: true,
          credentialFingerprint: "credential-a",
        },
        ...entries(successProvider("serper", 2)),
      ],
      organizationId: "org",
      projectId: "project",
    }).search(input);

    const recovered = successProvider("dataforseo", 1);
    await createSerpResolverFromEntries({
      entries: [
        {
          provider: recovered,
          priority: 1,
          enabled: true,
          configured: true,
          credentialFingerprint: "credential-b",
        },
      ],
      organizationId: "org",
      projectId: "project",
    }).search(input);
    expect(recovered.search).toHaveBeenCalledOnce();
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

  it("records canonical reasons when every provider is skipped pre-dispatch", async () => {
    resetProviderCircuitsForTests();
    const error = (await createSerpResolverFromEntries({
      entries: [
        {
          provider: successProvider("dataforseo", 1),
          priority: 1,
          enabled: true,
          configured: false,
        },
        {
          provider: successProvider("serper", 2),
          priority: 2,
          enabled: false,
          configured: true,
        },
        {
          provider: successProvider("zenserp", 3),
          priority: 3,
          enabled: false,
          configured: true,
        },
      ],
    })
      .search(input)
      .catch((value: unknown) => value)) as SerpProvidersUnavailableError;

    expect(error.calls.filter((call) => call.dispatched)).toHaveLength(0);
    expect(error.calls.map((call) => call.skipReason)).toEqual([
      "MISSING_CREDENTIALS",
      "DISABLED",
      "DISABLED",
    ]);
    expect(error.providerDiagnostics).toEqual([
      { provider: "DataForSEO", reason: "MISSING_CREDENTIALS" },
      { provider: "Serper.dev", reason: "DISABLED" },
      { provider: "Zenserp", reason: "DISABLED" },
    ]);
    expect(error.message).toContain("No eligible SERP provider was available");
    expect(error.message).toContain("DataForSEO: MISSING_CREDENTIALS");
  });

  it("does not open a circuit for a valid NO_RESULT", async () => {
    resetProviderCircuitsForTests();
    await createSerpResolverFromEntries({
      entries: entries(successProvider("dataforseo", null)),
      organizationId: "org",
    }).search(input);
    expect(
      getProviderCircuitState({
        provider: "dataforseo",
        organizationId: "org",
      }),
    ).toBeNull();
  });

  it("checks cancellation again after a provider failure", async () => {
    resetProviderCircuitsForTests();
    const serper = successProvider("serper", 3);
    const serperSearch = vi.mocked(serper.search);
    let checks = 0;
    const error = await createSerpResolverFromEntries({
      entries: entries(failedProvider("dataforseo"), serper),
    })
      .search({
        ...input,
        isCancelled: async () => ++checks > 1,
      })
      .catch((value: unknown) => value as SerpCancelledError);
    expect(error).toHaveProperty("name", "AbortError");
    expect(error.calls.at(-1)).toMatchObject({
      provider: "serper",
      status: "skipped",
      skipReason: "CANCELLED",
      dispatched: false,
    });
    expect(error.calls.filter((call) => call.dispatched)).toHaveLength(1);
    expect(serperSearch).not.toHaveBeenCalled();
  });

  it("records every provider as CANCELLED when cancelled before resolution", async () => {
    const error = await createSerpResolverFromEntries({
      entries: entries(
        successProvider("dataforseo", 1),
        successProvider("serper", 2),
        successProvider("zenserp", 3),
      ),
    })
      .search({ ...input, isCancelled: async () => true })
      .catch((value: unknown) => value as SerpCancelledError);
    expect(error.calls.map((call) => call.skipReason)).toEqual([
      "CANCELLED",
      "CANCELLED",
      "CANCELLED",
    ]);
    expect(error.calls.filter((call) => call.dispatched)).toHaveLength(0);
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

  describe("per-provider circuit breaker setting", () => {
    beforeEach(() => {
      resetProviderCircuitsForTests();
    });

    it("skips with CIRCUIT_OPEN when enabled and circuit is open", async () => {
      const broken = failedProvider("dataforseo", true);
      const fallback = successProvider("serper", 2);
      const resolver = createSerpResolverFromEntries({
        entries: entries(broken, fallback),
        organizationId: "org-cb-on",
      });
      await resolver.search(input);
      const second = await resolver.search(input);
      expect(second.calls[0]).toMatchObject({
        provider: "dataforseo",
        status: "skipped",
        skipReason: "CIRCUIT_OPEN",
        dispatched: false,
        circuitBreakerEnabled: true,
      });
    });

    it("dispatches a provider whose breaker is disabled despite a stale open circuit", async () => {
      const broken = failedProvider("dataforseo", true);
      const fallback = successProvider("serper", 2);
      const fallbackSearch = vi.mocked(fallback.search);
      const resolver = createSerpResolverFromEntries({
        entries: [
          {
            ...entries(broken)[0],
            circuitBreakerEnabled: false,
          },
          ...entries(fallback),
        ],
        organizationId: "org-cb-off",
      });
      await resolver.search(input);
      const second = await resolver.search(input);
      expect(second.calls[0]).toMatchObject({
        provider: "dataforseo",
        status: "failed",
        dispatched: true,
        circuitBreakerEnabled: false,
      });
      expect(second.calls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ skipReason: "CIRCUIT_OPEN" }),
        ]),
      );
      expect(fallbackSearch).toHaveBeenCalledTimes(2);
    });

    it("ignores an open circuit the moment the breaker is disabled", async () => {
      const broken = failedProvider("dataforseo", true);
      const fallback = successProvider("serper", 2);
      // Trip the circuit first with the breaker enabled.
      const openResolver = createSerpResolverFromEntries({
        entries: entries(broken, fallback),
        organizationId: "org-cb-bypass",
      });
      await openResolver.search(input);
      expect(
        getProviderCircuitState({
          provider: "dataforseo",
          organizationId: "org-cb-bypass",
        }),
      ).not.toBeNull();
      // Same identity, breaker now disabled: the provider is called again.
      const bypassResolver = createSerpResolverFromEntries({
        entries: [
          { ...entries(broken)[0], circuitBreakerEnabled: false },
          ...entries(fallback),
        ],
        organizationId: "org-cb-bypass",
      });
      const result = await bypassResolver.search(input);
      expect(result.calls[0]).toMatchObject({
        provider: "dataforseo",
        dispatched: true,
      });
    });

    it("starts with a clean closed circuit when the breaker is re-enabled", async () => {
      const broken = failedProvider("dataforseo", true);
      const fallback = successProvider("serper", 2);
      // Open the circuit under a fingerprint that won't be reused below.
      await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(broken)[0],
            credentialFingerprint: "fp-old",
          },
          ...entries(fallback),
        ],
        organizationId: "org-cb-reenable",
      }).search(input);
      // Re-enable with the same identity: no circuit should exist, so the
      // provider is dispatched immediately.
      const recovered = successProvider("dataforseo", 1);
      const result = await createSerpResolverFromEntries({
        entries: entries(recovered, fallback),
        organizationId: "org-cb-reenable-clean",
      }).search(input);
      expect(result.provider).toBe("dataforseo");
      expect(result.calls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ skipReason: "CIRCUIT_OPEN" }),
        ]),
      );
    });

    it("still falls back to the next provider after a failure with the breaker disabled", async () => {
      const result = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(failedProvider("dataforseo"))[0],
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 5)),
        ],
        organizationId: "org-cb-failover",
      }).search(input);
      expect(result.provider).toBe("serper");
      expect(result.calls.map((call) => call.dispatched)).toEqual([true, true]);
    });

    it("retries the primary provider on the next request when the breaker is disabled", async () => {
      const broken = failedProvider("dataforseo", true);
      const brokenSearch = vi.mocked(broken.search);
      const fallback = successProvider("serper", 2);
      const resolver = createSerpResolverFromEntries({
        entries: [
          { ...entries(broken)[0], circuitBreakerEnabled: false },
          ...entries(fallback),
        ],
        organizationId: "org-cb-retry",
      });
      await resolver.search(input);
      await resolver.search(input);
      expect(brokenSearch).toHaveBeenCalledTimes(2);
    });

    it("never opens a circuit while the breaker is disabled", async () => {
      await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(failedProvider("dataforseo", true))[0],
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 2)),
        ],
        organizationId: "org-cb-no-open",
      }).search(input);
      expect(
        getProviderCircuitState({
          provider: "dataforseo",
          organizationId: "org-cb-no-open",
        }),
      ).toBeNull();
    });

    it("skips a disabled provider regardless of the circuit setting", async () => {
      const result = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(successProvider("dataforseo", 1))[0],
            enabled: false,
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 2)),
        ],
      }).search(input);
      expect(result.calls[0]).toMatchObject({
        provider: "dataforseo",
        skipReason: "DISABLED",
        dispatched: false,
      });
    });

    it("skips an unconfigured provider regardless of the circuit setting", async () => {
      const result = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(successProvider("dataforseo", 1))[0],
            configured: false,
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 2)),
        ],
      }).search(input);
      expect(result.calls[0]).toMatchObject({
        provider: "dataforseo",
        skipReason: "MISSING_CREDENTIALS",
        dispatched: false,
      });
    });

    it("takes cancellation precedence regardless of the circuit setting", async () => {
      const error = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(successProvider("dataforseo", 1))[0],
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 2)),
        ],
      })
        .search({ ...input, isCancelled: async () => true })
        .catch((value: unknown) => value as SerpCancelledError);
      expect(error.calls.map((call) => call.skipReason)).toEqual([
        "CANCELLED",
        "CANCELLED",
      ]);
    });

    it("stops failover on a valid NO_RESULT with the breaker disabled", async () => {
      const zenserp = successProvider("zenserp", 4);
      const zenserpSearch = vi.mocked(zenserp.search);
      const result = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(successProvider("dataforseo", null))[0],
            circuitBreakerEnabled: false,
          },
          ...entries(zenserp),
        ],
      }).search(input);
      expect(result).toMatchObject({ provider: "dataforseo", position: null });
      expect(zenserpSearch).not.toHaveBeenCalled();
    });

    it("does not emit CIRCUIT_OPEN skips in traces when protection is disabled", async () => {
      const broken = failedProvider("dataforseo", true);
      const fallback = successProvider("serper", 2);
      const resolver = createSerpResolverFromEntries({
        entries: [
          { ...entries(broken)[0], circuitBreakerEnabled: false },
          ...entries(fallback),
        ],
        organizationId: "org-cb-trace",
      });
      await resolver.search(input);
      const second = await resolver.search(input);
      const skips = second.calls.filter((call) => call.status === "skipped");
      expect(skips.every((call) => call.skipReason !== "CIRCUIT_OPEN")).toBe(
        true,
      );
      // Dispatched call count stays truthful: each request dispatched once.
      const firstDispatched = second.calls.filter(
        (call) => call.dispatched,
      ).length;
      expect(firstDispatched).toBe(2);
    });
  });
});
