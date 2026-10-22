import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { SALLA_API_BASE_URL } from "./sallaConfig";

// Salla Merchant API (admin/v2) client for the read-only catalog surface.
// Verified against docs.salla.dev: GET /products (scope products.read) and
// GET /categories (scope categories.read), `page` + `per_page` (max 60),
// `format=light` for reduced responses, and a `pagination` block whose
// documented shape differs per route, so both documented shapes parse.

const PER_PAGE_MAX = 60;

/**
 * A JSON value as the Merchant API returns it. The connector never
 * interprets the fields (§1.5), so a row keeps the wire shape instead of
 * pretending the API only ever returns primitives.
 */
export type SallaCatalogValue =
  | string
  | number
  | boolean
  | null
  | SallaCatalogValue[]
  | { [key: string]: SallaCatalogValue };

/** One catalog row: a JSON object of catalog fields. */
export type SallaCatalogRow = Record<string, SallaCatalogValue>;

/**
 * The provider's JSON, validated at the trust boundary: every catalog value
 * is a plain JSON value, so a row can never smuggle in something the server
 * function could not serialize back to the client.
 */
const catalogValueSchema: z.ZodType<SallaCatalogValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(catalogValueSchema),
    z.record(z.string(), catalogValueSchema),
  ]),
);

// The pagination block's documented shape differs per route (detailed numbers
// vs a cursor-style `next` URL), and both shapes carry optional-only fields,
// so one schema accepts every documented key and the page walker branches on
// the values it actually finds.
const paginationSchema = z
  .object({
    count: z.number().optional(),
    total: z.number().optional(),
    perPage: z.number().optional(),
    currentPage: z.number().optional(),
    totalPages: z.number().optional(),
    current: z.number().optional(),
    next: z.string().optional(),
  })
  .nullable();

const listResponseSchema = z.object({
  status: z.number().optional(),
  success: z.boolean().optional(),
  data: z.array(z.record(z.string(), catalogValueSchema)),
  pagination: paginationSchema.optional(),
});

export type SallaListResponse = z.output<typeof listResponseSchema>;

export type SallaNextPage = number | null;

function nextPageFromPagination(
  pagination: SallaListResponse["pagination"],
): SallaNextPage {
  if (!pagination) return null;
  if (typeof pagination.totalPages === "number") {
    const currentPage =
      typeof pagination.currentPage === "number" ? pagination.currentPage : 1;
    return currentPage < pagination.totalPages ? currentPage + 1 : null;
  }
  // Cursor-style pagination: `next` is a full URL for the next page.
  if (typeof pagination.next === "string" && pagination.next) {
    try {
      const next = new URL(pagination.next);
      const page = Number(next.searchParams.get("page"));
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with honest rate-limit handling: a 429 retries after the documented
 * `retry-after` hint (seconds, bounded) with bounded attempts — never
 * silently swallowing the failure. Any other non-2xx surfaces as
 * UPSTREAM_UNAVAILABLE immediately (401/403 are authorization problems the
 * service's refresh flow must decide about).
 */
async function getWithRetries(
  url: URL,
  accessToken: string,
  maxAttempts = 3,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (response.ok) return response;
    if (response.status === 429) {
      if (attempt === maxAttempts) break;
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds, 30) * 1_000
          : attempt * 1_000;
      await sleep(backoffMs);
      continue;
    }
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `Salla API returned HTTP ${response.status} on ${url.pathname}.`,
    );
  }
  throw new AppError(
    "RATE_LIMITED",
    "Salla API rate limit exhausted after retries.",
  );
}

async function fetchListPage(input: {
  path: string;
  accessToken: string;
  page: number;
  perPage: number;
}): Promise<{ body: SallaListResponse; nextPage: SallaNextPage }> {
  const url = new URL(`${SALLA_API_BASE_URL}${input.path}`);
  url.searchParams.set("page", String(input.page));
  url.searchParams.set(
    "per_page",
    String(Math.min(input.perPage, PER_PAGE_MAX)),
  );
  const response = await getWithRetries(url, input.accessToken);
  const raw: unknown = await response.json();
  const parsed = listResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `Salla API returned an unexpected list shape on ${input.path}.`,
    );
  }
  return {
    body: parsed.data,
    nextPage: nextPageFromPagination(parsed.data.pagination ?? null),
  };
}

export type SallaCatalogFetch = {
  rows: SallaCatalogRow[];
  pagesFetched: number;
  truncatedByCap: boolean;
  nextPage: SallaNextPage;
};

/**
 * Walk a Salla list endpoint with a hard page cap so one request can never
 * stream an unbounded number of provider calls. When the cap stops a longer
 * store, `truncatedByCap` is true and `nextPage` tells the caller to
 * continue in a later turn — no unbounded background work.
 */
export async function fetchSallaList(input: {
  path: string;
  accessToken: string;
  startPage?: number;
  perPage?: number;
  maxPages?: number;
}): Promise<SallaCatalogFetch> {
  const maxPages = Math.min(input.maxPages ?? 10, 50);
  const rows: SallaCatalogRow[] = [];
  let page = Math.max(input.startPage ?? 1, 1);
  let pagesFetched = 0;
  let nextPage: SallaNextPage = null;
  let truncatedByCap = false;

  while (pagesFetched < maxPages) {
    const result = await fetchListPage({
      path: input.path,
      accessToken: input.accessToken,
      page,
      perPage: input.perPage ?? PER_PAGE_MAX,
    });
    rows.push(...result.body.data);
    pagesFetched++;
    nextPage = result.nextPage;
    if (nextPage === null) break;
    page = nextPage;
  }
  if (nextPage !== null) {
    // Either the cap stopped us mid-store, or pagination reported more.
    truncatedByCap = true;
  }

  return { rows, pagesFetched, truncatedByCap, nextPage };
}

export const SALLA_PRODUCTS_PATH = "/products";
export const SALLA_CATEGORIES_PATH = "/categories";
