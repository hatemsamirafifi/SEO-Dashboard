import { describe, expect, it, vi } from "vitest";
import { createHttpSerpProvider } from "./httpProviders";
import { SerpProviderError, type SerpSearchInput } from "./types";

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

describe("HTTP SERP providers", () => {
  it("normalizes a Serper organic match and maps documented parameters", async () => {
    const fetchFn = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const body: unknown = JSON.parse(rawBody);
        expect(body).toMatchObject({
          q: input.keyword,
          gl: "ae",
          hl: "en",
          num: 10,
          page: 1,
        });
        expect(new Headers(init?.headers).get("X-API-KEY")).toBe("secret-key");
        return new Response(
          JSON.stringify({
            organic: [
              {
                position: 9,
                title: "Example",
                link: "https://www.example.com/page",
              },
            ],
          }),
          { status: 200 },
        );
      },
    );
    const result = await createHttpSerpProvider({
      id: "serper",
      apiKey: "secret-key",
      fetchFn,
    }).search(input);
    expect(result).toMatchObject({
      provider: "serper",
      position: 9,
      domain: "example.com",
      inspectedDepth: 9,
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("returns NO_RESULT only after the requested depth is inspected", async () => {
    const noResult = createHttpSerpProvider({
      id: "serper",
      apiKey: "key",
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              organic: Array.from({ length: 10 }, (_, index) => ({
                position: index + 1,
                link: `https://other-${index}.test`,
              })),
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await noResult.search({ ...input, depth: 10 });
    expect(result).toMatchObject({ position: null, inspectedDepth: 10 });
    expect(result.calls.at(-1)).toMatchObject({
      requestedDepth: 10,
      inspectedDepth: 10,
      pagesRequested: 1,
      resultCompleteness: "complete",
    });
  });

  it("does not turn a short depth-100 response into NO_RESULT", async () => {
    const fetchFn = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const parsed: unknown = JSON.parse(rawBody);
        const page =
          typeof parsed === "object" &&
          parsed !== null &&
          "page" in parsed &&
          typeof parsed.page === "number"
            ? parsed.page
            : 1;
        return new Response(
          JSON.stringify({
            organic:
              page === 1
                ? Array.from({ length: 8 }, (_, index) => ({
                    position: index + 1,
                    link: `https://other-${index}.test`,
                  }))
                : [],
          }),
        );
      },
    );
    const provider = createHttpSerpProvider({
      id: "serper",
      apiKey: "key",
      fetchFn,
    });
    let caught: SerpProviderError | null = null;
    try {
      await provider.search(input);
    } catch (e) {
      if (e instanceof SerpProviderError) {
        caught = e;
      }
    }
    expect(caught).not.toBeNull();
    if (caught) {
      expect(caught.code).toBe("INSUFFICIENT_DEPTH");
      expect(caught.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestedDepth: 100,
            inspectedDepth: 8,
          }),
        ]),
      );
    }
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("paginates Serper until depth 100 is truthfully inspected", async () => {
    const fetchFn = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const parsed: unknown = JSON.parse(rawBody);
        const page =
          typeof parsed === "object" &&
          parsed !== null &&
          "page" in parsed &&
          typeof parsed.page === "number"
            ? parsed.page
            : 1;
        return new Response(
          JSON.stringify({
            organic: Array.from({ length: 10 }, (_, index) => ({
              position: index + 1,
              link: `https://other-${page}-${index}.test`,
            })),
          }),
        );
      },
    );
    const result = await createHttpSerpProvider({
      id: "serper",
      apiKey: "key",
      fetchFn,
    }).search(input);
    expect(result).toMatchObject({ position: null, inspectedDepth: 100 });
    expect(fetchFn).toHaveBeenCalledTimes(10);
    expect(result.calls.at(-1)).toMatchObject({
      pagesRequested: 10,
      resultCompleteness: "complete",
    });
  });

  it("checks cancellation before every Serper page", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organic: Array.from({ length: 8 }, (_, index) => ({
              position: index + 1,
              link: `https://other-${index}.test`,
            })),
          }),
        ),
    );
    let cancellationChecks = 0;
    await expect(
      createHttpSerpProvider({
        id: "serper",
        apiKey: "key",
        fetchFn,
      }).search({
        ...input,
        isCancelled: async () => ++cancellationChecks > 1,
      }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed successful responses", async () => {
    const malformed = createHttpSerpProvider({
      id: "serper",
      apiKey: "key",
      fetchFn: vi.fn(async () => new Response("not json", { status: 200 })),
    });
    await expect(malformed.search(input)).rejects.toMatchObject({
      code: "MALFORMED_JSON",
    });
  });

  it.each([
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
  ])("classifies HTTP %i without leaking the key", async (status, code) => {
    const provider = createHttpSerpProvider({
      id: "serper",
      apiKey: "do-not-leak",
      fetchFn: vi.fn(async () => new Response("failure", { status })),
    });
    const error = await provider.search(input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain("do-not-leak");
  });

  it.each(["serper", "zenserp"] as const)(
    "%s classifies quota exhaustion and network timeouts",
    async (id) => {
      const quota = createHttpSerpProvider({
        id,
        apiKey: "do-not-leak",
        fetchFn: vi.fn(
          async () => new Response("monthly quota exhausted", { status: 429 }),
        ),
      });
      await expect(quota.search(input)).rejects.toMatchObject({
        code: "QUOTA_EXHAUSTED",
        deterministic: true,
      });
      const timeout = createHttpSerpProvider({
        id,
        apiKey: "do-not-leak",
        fetchFn: vi.fn(async () => {
          throw new DOMException("timed out", "TimeoutError");
        }),
      });
      await expect(timeout.search(input)).rejects.toMatchObject({
        code: "NETWORK_OR_TIMEOUT",
      });
    },
  );

  it.each(["serper", "zenserp"] as const)(
    "%s rejects a structurally invalid successful response",
    async (id) => {
      const provider = createHttpSerpProvider({
        id,
        apiKey: "key",
        fetchFn: vi.fn(
          async () => new Response(JSON.stringify({ results: [] })),
        ),
      });
      await expect(provider.search(input)).rejects.toMatchObject({
        code: "INVALID_PROVIDER_RESPONSE",
      });
    },
  );

  it("maps Zenserp hl, gl, device, num and start with header authentication", async () => {
    const fetchFn = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const parsed = new URL(
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        );
        expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
          q: input.keyword,
          engine: "google",
          gl: "ae",
          hl: "en",
          device: "mobile",
          num: "10",
          start: "0",
        });
        expect(new Headers(init?.headers).get("apikey")).toBe("zen-key");
        return new Response(
          JSON.stringify({
            organic: [
              { position: 4, title: "Example", url: "https://example.com" },
            ],
          }),
          { status: 200 },
        );
      },
    );
    const result = await createHttpSerpProvider({
      id: "zenserp",
      apiKey: "zen-key",
      fetchFn,
    }).search({ ...input, device: "mobile" });
    expect(result.position).toBe(4);
  });

  it("paginates Zenserp with start offsets until requested depth", async () => {
    const starts: number[] = [];
    const fetchFn = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      );
      const start = Number(parsed.searchParams.get("start"));
      starts.push(start);
      return new Response(
        JSON.stringify({
          organic: Array.from({ length: 10 }, (_, index) => ({
            position: index + 1,
            url: `https://other-${start}-${index}.test`,
          })),
        }),
      );
    });
    const result = await createHttpSerpProvider({
      id: "zenserp",
      apiKey: "zen-key",
      fetchFn,
    }).search({ ...input, depth: 30 });
    expect(starts).toEqual([0, 10, 20]);
    expect(result).toMatchObject({ position: null, inspectedDepth: 30 });
    expect(result.calls).toHaveLength(3);
  });

  it("does not claim mobile support for Serper", () => {
    const provider = createHttpSerpProvider({ id: "serper", apiKey: "key" });
    expect(provider.supports({ ...input, device: "mobile" })).toBe(false);
  });
});
