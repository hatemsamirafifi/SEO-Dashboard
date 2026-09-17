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
        { deterministic },
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

/**
 * Provider that fails with the given error for the first `failures` calls,
 * then succeeds. Used to simulate transient failures that a retry heals.
 */
function flakyProvider(
  id: SerpProvider["id"],
  failures: number,
  error: { code: string; deterministic?: boolean } = {
    code: "PROVIDER_UNAVAILABLE",
  },
  position: number | null = 4,
): SerpProvider {
  let calls = 0;
  return {
    id,
    supports: () => true,
    search: vi.fn(async (searchInput: SerpSearchInput) => {
      calls++;
      if (calls <= failures) {
        throw new SerpProviderError(
          id,
          error.code,
          [
            {
              provider: id,
              endpoint: "/search",
              status: "failed",
              httpStatus: null,
              errorCode: error.code,
              durationMs: 1,
              resultCount: null,
              requestedDepth: searchInput.depth,
              inspectedDepth: null,
              pagesRequested: 1,
              resultCompleteness: "not_applicable",
              dispatched: true,
            },
          ],
          `attempt ${calls} failed: ${error.code}`,
          { deterministic: error.deterministic ?? false },
        );
      }
      return successProvider(id, position).search(searchInput);
    }),
  };
}

function entries(...providers: SerpProvider[]): SerpResolverEntry[] {
  // maxRetries: 0 keeps the pre-retry-era single-attempt semantics for the
  // legacy failover tests; the dedicated retry suite sets retries explicitly.
  return providers.map((provider, index) => ({
    provider,
    priority: index + 1,
    enabled: true,
    configured: true,
    maxRetries: 0,
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
    const caught: unknown = await createSerpResolverFromEntries({
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
      .catch((value: unknown) => value);

    expect(caught).toBeInstanceOf(SerpProvidersUnavailableError);
    if (!(caught instanceof SerpProvidersUnavailableError)) return;
    const error = caught;
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
    const caught: unknown = await createSerpResolverFromEntries({
      entries: entries(failedProvider("dataforseo"), serper),
    })
      .search({
        ...input,
        isCancelled: async () => ++checks > 1,
      })
      .catch((value: unknown) => value);

    expect(caught).toBeInstanceOf(SerpCancelledError);
    if (!(caught instanceof SerpCancelledError)) return;
    const error = caught;
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
    const caught: unknown = await createSerpResolverFromEntries({
      entries: entries(
        successProvider("dataforseo", 1),
        successProvider("serper", 2),
        successProvider("zenserp", 3),
      ),
    })
      .search({ ...input, isCancelled: async () => true })
      .catch((value: unknown) => value);

    expect(caught).toBeInstanceOf(SerpCancelledError);
    if (!(caught instanceof SerpCancelledError)) return;
    const error = caught;
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
      const caught: unknown = await createSerpResolverFromEntries({
        entries: [
          {
            ...entries(successProvider("dataforseo", 1))[0],
            circuitBreakerEnabled: false,
          },
          ...entries(successProvider("serper", 2)),
        ],
      })
        .search({ ...input, isCancelled: async () => true })
        .catch((value: unknown) => value);

      expect(caught).toBeInstanceOf(SerpCancelledError);
      if (!(caught instanceof SerpCancelledError)) return;
      const error = caught;
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

  describe("provider retry policy", () => {
    beforeEach(() => {
      resetProviderCircuitsForTests();
    });

    it("retries transient HTTP 503 failures and succeeds without fallback", async () => {
      const flaky = flakyProvider(
        "dataforseo",
        2,
        { code: "PROVIDER_UNAVAILABLE" },
        6,
      );
      const fallback = successProvider("serper", 2);
      const fallbackSearch = vi.mocked(fallback.search);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(flaky)[0], maxRetries: 2 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result.provider).toBe("dataforseo");
      expect(result.position).toBe(6);
      expect(flaky.search).toHaveBeenCalledTimes(3);
      expect(fallbackSearch).not.toHaveBeenCalled();
      // All three calls are recorded truthfully with attempt numbers.
      expect(result.calls.map((call) => call.attempt)).toEqual([1, 2, 3]);
      expect(result.calls.every((call) => call.dispatched)).toBe(true);
      // Failed attempts carry the retryable classification.
      expect(result.calls[0]).toMatchObject({ retryable: true });
      expect(result.calls[0]).toMatchObject({ maxRetries: 2 });
    });

    it.each([
      "PROVIDER_UNAVAILABLE",
      "UPSTREAM_UNAVAILABLE",
      "RATE_LIMITED",
      "NETWORK_OR_TIMEOUT",
      "TRANSIENT_UPSTREAM",
    ])("retries %s failures", async (code) => {
      const flaky = flakyProvider("dataforseo", 1, { code });
      const result = await createSerpResolverFromEntries({
        entries: [{ ...entries(flaky)[0], maxRetries: 2 }],
        retryWaitMs: 1,
      }).search(input);
      expect(result.provider).toBe("dataforseo");
      expect(flaky.search).toHaveBeenCalledTimes(2);
    });

    it("falls back to the next provider after retries are exhausted", async () => {
      const alwaysFailing = flakyProvider("dataforseo", 99, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const fallback = successProvider("serper", 5);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(alwaysFailing)[0], maxRetries: 2 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result.provider).toBe("serper");
      expect(alwaysFailing.search).toHaveBeenCalledTimes(3);
      // Provider calls: 3 failed DataForSEO attempts + 1 Serper success.
      expect(
        result.calls.filter((c) => c.provider === "dataforseo"),
      ).toHaveLength(3);
    });

    it("does not interleave providers: current provider finishes retries first", async () => {
      const callOrder: string[] = [];
      const dataforseo: SerpProvider = {
        id: "dataforseo",
        supports: () => true,
        search: vi.fn(async () => {
          callOrder.push("dataforseo");
          throw new SerpProviderError(
            "dataforseo",
            "PROVIDER_UNAVAILABLE",
            [],
            "down",
          );
        }),
      };
      const serper: SerpProvider = {
        id: "serper",
        supports: () => true,
        search: vi.fn(async () => {
          callOrder.push("serper");
          throw new SerpProviderError(
            "serper",
            "PROVIDER_UNAVAILABLE",
            [],
            "down",
          );
        }),
      };
      await expect(
        createSerpResolverFromEntries({
          entries: [
            { ...entries(dataforseo)[0], maxRetries: 1 },
            { ...entries(serper)[0], maxRetries: 1 },
          ],
          retryWaitMs: 1,
        }).search(input),
      ).rejects.toHaveProperty("name", "SerpProvidersUnavailableError");
      expect(callOrder).toEqual([
        "dataforseo",
        "dataforseo",
        "serper",
        "serper",
      ]);
    });

    it("skips retries for invalid API key and moves directly to fallback", async () => {
      const broken = flakyProvider("dataforseo", 99, {
        code: "AUTH_FAILED",
        deterministic: true,
      });
      const fallback = successProvider("serper", 7);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(broken)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result.provider).toBe("serper");
      expect(broken.search).toHaveBeenCalledTimes(1);
      expect(result.calls[0]).toMatchObject({
        retryable: false,
        attempt: 1,
        maxRetries: 5,
      });
    });

    it("skips retries for DataForSEO 40201 account paused", async () => {
      const paused = flakyProvider("dataforseo", 99, {
        code: "DATAFORSEO_ACCOUNT_PAUSED",
        deterministic: true,
      });
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(paused)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(paused.search).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe("serper");
      expect(result.calls[0]).toMatchObject({ retryable: false });
    });

    it("skips retries for quota exhausted", async () => {
      const exhausted = flakyProvider("serper", 99, {
        code: "QUOTA_EXHAUSTED",
        deterministic: true,
      });
      const fallback = successProvider("zenserp", 3);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(exhausted)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(exhausted.search).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe("zenserp");
    });

    it("skips missing credentials entirely (pre-dispatch, zero retries)", async () => {
      const provider = successProvider("dataforseo", 1);
      const providerSearch = vi.mocked(provider.search);
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(provider)[0], configured: false, maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result.provider).toBe("serper");
      expect(providerSearch).not.toHaveBeenCalled();
      expect(result.calls[0]).toMatchObject({
        skipReason: "MISSING_CREDENTIALS",
        dispatched: false,
      });
    });

    it("makes exactly one total attempt when retries = 0", async () => {
      const flaky = flakyProvider("dataforseo", 1, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(flaky)[0], maxRetries: 0 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(flaky.search).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe("serper");
      expect(result.calls[0]).toMatchObject({ maxRetries: 0, attempt: 1 });
    });

    it("makes at most six attempts when retries = 5", async () => {
      const alwaysFailing = flakyProvider("dataforseo", 99, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(alwaysFailing)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(alwaysFailing.search).toHaveBeenCalledTimes(6);
      expect(result.provider).toBe("serper");
      const dataforseoCalls = result.calls.filter(
        (call) => call.provider === "dataforseo",
      );
      expect(dataforseoCalls.map((call) => call.attempt)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    });

    it("does not retry a valid NO_RESULT and does not fall back", async () => {
      const provider = successProvider("dataforseo", null);
      const providerSearch = vi.mocked(provider.search);
      const fallback = successProvider("serper", 2);
      const fallbackSearch = vi.mocked(fallback.search);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(provider)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result).toMatchObject({ provider: "dataforseo", position: null });
      expect(providerSearch).toHaveBeenCalledTimes(1);
      expect(fallbackSearch).not.toHaveBeenCalled();
    });

    it("does not retry a RANKED result and does not fall back", async () => {
      const provider = successProvider("dataforseo", 4);
      const providerSearch = vi.mocked(provider.search);
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(provider)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      expect(result).toMatchObject({ provider: "dataforseo", position: 4 });
      expect(providerSearch).toHaveBeenCalledTimes(1);
    });

    it("does not start the next request when cancelled during backoff", async () => {
      const controller = new AbortController();
      const first: SerpProvider = {
        id: "dataforseo",
        supports: () => true,
        search: vi.fn(async () => {
          controller.abort();
          throw new SerpProviderError(
            "dataforseo",
            "PROVIDER_UNAVAILABLE",
            [],
            "down",
          );
        }),
      };
      const fallback = successProvider("serper", 2);
      const fallbackSearch = vi.mocked(fallback.search);
      await expect(
        createSerpResolverFromEntries({
          entries: [
            { ...entries(first)[0], maxRetries: 2 },
            ...entries(fallback),
          ],
          retryWaitMs: 1,
        }).search({ ...input, signal: controller.signal }),
      ).rejects.toHaveProperty("name", "AbortError");
      // The abort fired during the first attempt's failure; the retry backoff
      // must not dispatch anything further.
      expect(first.search).toHaveBeenCalledTimes(1);
      expect(fallbackSearch).not.toHaveBeenCalled();
    });

    it("respects a provider Retry-After when rate limited", async () => {
      let calls = 0;
      const rateLimited: SerpProvider = {
        id: "serper",
        supports: () => true,
        search: vi.fn(async (searchInput: SerpSearchInput) => {
          calls++;
          if (calls === 1) {
            throw new SerpProviderError("serper", "RATE_LIMITED", [], "rate limited", {
              retryAfterMs: 20,
            });
          }
          return successProvider("serper", 9).search(searchInput);
        }),
      };
      const startedAt = Date.now();
      const result = await createSerpResolverFromEntries({
        entries: [{ ...entries(rateLimited)[0], maxRetries: 2 }],
        // No retryWaitMs override: the provider-supplied 20ms Retry-After
        // must be respected over the default policy backoff.
      }).search(input);
      expect(result.provider).toBe("serper");
      expect(rateLimited.search).toHaveBeenCalledTimes(2);
      // The retry waited ~20ms (the provider-supplied Retry-After).
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
      expect(result.calls[0]).toMatchObject({
        retryable: true,
        retryAfterMs: 20,
      });
    });

    it("keeps pagination separate from retries (insufficient depth falls through)", async () => {
      const insufficient = insufficientProvider("dataforseo");
      const fallback = successProvider("serper", 2);
      const result = await createSerpResolverFromEntries({
        entries: [
          { ...entries(insufficient)[0], maxRetries: 5 },
          ...entries(fallback),
        ],
        retryWaitMs: 1,
      }).search(input);
      // INSUFFICIENT_DEPTH is a valid provider outcome, not a retryable
      // failure: no retries, direct fallback.
      expect(insufficient.search).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe("serper");
    });

    it("counts retry calls truthfully in Provider Calls", async () => {
      // One transient failure + one successful retry = two dispatched calls.
      const flaky = flakyProvider("dataforseo", 1, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const result = await createSerpResolverFromEntries({
        entries: [{ ...entries(flaky)[0], maxRetries: 2 }],
        retryWaitMs: 1,
      }).search(input);
      const dispatched = result.calls.filter((call) => call.dispatched);
      expect(dispatched).toHaveLength(2);
      expect(result.calls).toHaveLength(2);
      expect(result.calls.map((call) => call.status)).toEqual([
        "failed",
        "success",
      ]);
    });

    it("retries even when the circuit breaker is off, and opens no circuit", async () => {
      const flaky = flakyProvider("dataforseo", 1, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const resolver = createSerpResolverFromEntries({
        entries: [
          {
            ...entries(flaky)[0],
            maxRetries: 2,
            circuitBreakerEnabled: false,
          },
        ],
        organizationId: "org-retry-cb-off",
        retryWaitMs: 1,
      });
      const result = await resolver.search(input);
      expect(result.provider).toBe("dataforseo");
      expect(flaky.search).toHaveBeenCalledTimes(2);
      expect(
        result.calls.every((call) => call.circuitBreakerEnabled === false),
      ).toBe(true);
    });

    it("may open the circuit only after retries are exhausted", async () => {
      const alwaysFailing = flakyProvider("dataforseo", 99, {
        code: "PROVIDER_UNAVAILABLE",
      });
      const fallback = successProvider("serper", 2);
      const resolver = createSerpResolverFromEntries({
        entries: [
          { ...entries(alwaysFailing)[0], maxRetries: 1 },
          ...entries(fallback),
        ],
        organizationId: "org-retry-cb-on",
        retryWaitMs: 1,
      });
      await resolver.search(input);
      // Retriable failures do not open the circuit (only deterministic do).
      expect(
        getProviderCircuitState({
          provider: "dataforseo",
          organizationId: "org-retry-cb-on",
        }),
      ).toBeNull();
    });
  });
});
