import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  fetchSallaList,
  SALLA_CATEGORIES_PATH,
  SALLA_PRODUCTS_PATH,
} from "./sallaApi";
import { SALLA_API_BASE_URL } from "./sallaConfig";
import { requestUrl } from "./sallaTestHelpers";

vi.mock("cloudflare:workers", () => ({ env: {} }));

// Mock-tested Salla Merchant API client: the two documented pagination
// shapes, the per_page=60 cap, bounded 429 retries honoring `retry-after`,
// and honest TRUNCATION signals instead of unbounded walks (§1.5).

const ADDRESSES = [
  { id: 1, name: "Product one" },
  { id: 2, name: "Product two" },
  { id: 3, name: "Product three" },
];

function pageBody(rows: { id: number }[]): Record<string, unknown> {
  return { status: 200, success: true, data: rows, pagination: null };
}

/** Detailed pagination as documented for GET /products and /categories. */
function detailedPagination(input: {
  count: number;
  total: number;
  perPage: number;
  currentPage: number;
  totalPages: number;
}) {
  return { ...input };
}

/** Cursor-style pagination shape documented on other Salla routes. */
function cursorPagination(input: {
  count: number;
  current: number;
  next?: string;
}) {
  return { ...input };
}

/** Make a fetch that counts calls and emits a scripted list of pages. */
function scriptFetch(
  pages: Array<{
    status: number;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
  }>,
) {
  let call = 0;
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: new URL(requestUrl(input)), init });
      const page = pages[Math.floor(call)] ?? pages[pages.length - 1];
      if (!page) throw new Error("Fetch called beyond scripted pages");
      call++;
      return new Response(JSON.stringify(page.body), {
        status: page.status,
        headers: page.headers ?? { "Content-Type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchFn: fetchMock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Salla list paths", () => {
  it("uses the documented read-only endpoints", () => {
    expect(SALLA_PRODUCTS_PATH).toBe("/products");
    expect(SALLA_CATEGORIES_PATH).toBe("/categories");
  });
});

describe("Salla pagination shapes", () => {
  it("walks detailed pagination and stops at the last page", async () => {
    const { calls, fetchFn } = scriptFetch([
      {
        status: 200,
        body: {
          data: ADDRESSES.slice(0, 2),
          pagination: detailedPagination({
            count: 2,
            total: 3,
            perPage: 2,
            currentPage: 1,
            totalPages: 2,
          }),
        },
      },
      {
        status: 200,
        body: {
          data: ADDRESSES.slice(2),
          pagination: detailedPagination({
            count: 1,
            total: 3,
            perPage: 2,
            currentPage: 2,
            totalPages: 2,
          }),
        },
      },
    ]);
    const result = await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
      perPage: 2,
    });
    expect(result.rows).toHaveLength(3);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncatedByCap).toBe(false);
    expect(result.nextPage).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls[0].url.searchParams.get("page")).toBe("1");
    expect(calls[1].url.searchParams.get("page")).toBe("2");
    expect(calls[0].url.searchParams.get("per_page")).toBe("2");
  });

  it("walks cursor-style pagination via the `next` URL page param", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: {
          data: ADDRESSES.slice(0, 2),
          pagination: cursorPagination({
            count: 2,
            current: 1,
            next: `${SALLA_API_BASE_URL}/products?page=2&per_page=2`,
          }),
        },
      },
      {
        status: 200,
        body: {
          data: ADDRESSES.slice(2),
          pagination: cursorPagination({ count: 1, current: 2 }),
        },
      },
    ]);
    const result = await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
      perPage: 2,
    });
    expect(result.rows).toHaveLength(3);
    expect(result.pagesFetched).toBe(2);
    expect(result.nextPage).toBeNull();
    expect(calls[1].url.searchParams.get("page")).toBe("2");
  });

  it("keeps `per_page` within the docs max of 60", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: pageBody([ADDRESSES[0]]),
      },
    ]);
    await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
      perPage: 500,
    });
    expect(calls[0].url.searchParams.get("per_page")).toBe("60");
  });

  it("sends the bearer token and Accept header (never seals secrets in URLs)", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: pageBody([ADDRESSES[0]]),
      },
    ]);
    await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
    });
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer ory_at_x",
      Accept: "application/json",
    });
    expect(calls[0].url.toString()).not.toContain("ory_at_x");
  });
});

describe("Salla bounded fetches", () => {
  it("caps page walks at the requested maxPages (never unbounded)", async () => {
    const { fetchFn } = scriptFetch(
      Array.from({ length: 20 }, (_, index) => ({
        status: 200,
        body: {
          data: ADDRESSES.slice(0, 1),
          pagination: detailedPagination({
            count: 1,
            total: 9999,
            perPage: 1,
            currentPage: index + 1,
            totalPages: 9999,
          }),
        },
      })),
    );
    const result = await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
      maxPages: 3,
    });
    expect(result.pagesFetched).toBe(3);
    expect(result.truncatedByCap).toBe(true);
    expect(result.nextPage).toBe(4);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("resumes from startPage without re-fetching earlier pages", async () => {
    const { calls } = scriptFetch(
      Array.from({ length: 12 }, (_, index) => ({
        status: 200,
        body: {
          data: ADDRESSES.slice(0, 1),
          pagination: detailedPagination({
            count: 1,
            total: 9999,
            perPage: 1,
            currentPage: index + 7,
            totalPages: 9999,
          }),
        },
      })),
    );
    const result = await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
      startPage: 7,
      maxPages: 2,
    });
    expect(calls[0].url.searchParams.get("page")).toBe("7");
    expect(result.pagesFetched).toBe(2);
    expect(result.nextPage).toBe(9);
  });
});

describe("Salla rate-limit handling", () => {
  it("retries a 429 twice with retry-after backoff, then succeeds", async () => {
    const { fetchFn } = scriptFetch([
      { status: 429, body: {}, headers: { "retry-after": "0.5" } },
      { status: 429, body: {}, headers: { "retry-after": "0.6" } },
      {
        status: 200,
        body: pageBody([ADDRESSES[0]]),
      },
    ]);
    const result = await fetchSallaList({
      path: SALLA_PRODUCTS_PATH,
      accessToken: "ory_at_x",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.truncatedByCap).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("fails with RATE_LIMITED once the attempt budget is exhausted", async () => {
    const { fetchFn } = scriptFetch([
      { status: 429, body: {}, headers: { "retry-after": "0.3" } },
      { status: 429, body: {}, headers: { "retry-after": "0.3" } },
      { status: 429, body: {}, headers: { "retry-after": "0.3" } },
    ]);
    await expect(
      fetchSallaList({
        path: SALLA_PRODUCTS_PATH,
        accessToken: "ory_at_x",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("surfaces other non-2xx immediately as UPSTREAM_UNAVAILABLE", async () => {
    const { fetchFn } = scriptFetch([
      { status: 401, body: { error: "unauthorized" } },
      {
        status: 200,
        body: pageBody([ADDRESSES[0]]),
      },
    ]);
    await expect(
      fetchSallaList({
        path: SALLA_PRODUCTS_PATH,
        accessToken: "ory_at_stale",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    // 401 is an authorization problem for the refresh flow, not a retry.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that is not the documented list envelope", async () => {
    scriptFetch([
      {
        status: 200,
        body: { total_count: 1, items: [ADDRESSES[0]] },
      },
    ]);
    await expect(
      fetchSallaList({
        path: SALLA_PRODUCTS_PATH,
        accessToken: "ory_at_x",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
