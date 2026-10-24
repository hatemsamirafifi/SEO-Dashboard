/* eslint-disable max-lines */
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import {
  GOOGLE_ADS_API_HOST,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_OAUTH_PROVIDER_ID,
  GOOGLE_ADS_CUSTOMER_ID_PATTERN,
  GOOGLE_ADS_CUSTOMER_RESOURCE_PATTERN,
  formatGoogleAdsCustomerId,
  normalizeGoogleAdsCustomerId,
} from "@/shared/google-ads";
import {
  buildHistoricalMetricsRequest,
  buildKeywordIdeasRequest,
  GOOGLE_ADS_DEFAULT_PLANNER_NETWORK,
  GOOGLE_ADS_PLANNER_SOURCE,
  type GoogleAdsHistoricalMetricsInput,
  type GoogleAdsHistoricalMetricsResult,
  type GoogleAdsKeywordIdeasInput,
  type GoogleAdsKeywordIdeasResult,
} from "./googleAdsPlanner";
import {
  collectKeywordRecords,
  parseHistoricalPage,
  parseIdeasPage,
} from "./googleAdsPlanner.metrics";
import {
  buildGeoTargetSuggestRequest,
  buildLanguageConstantQuery,
  parseGeoTargetSuggestions,
  parseLanguageConstants,
  selectCountryGeoTargetConstant,
  selectLanguageConstant,
  type GoogleAdsGeoTargetConstant,
  type GoogleAdsGeoTargetSuggestBody,
  type GoogleAdsGeoTargetSuggestInput,
  type GoogleAdsLanguageConstant,
  type GoogleAdsLanguageConstantInput,
} from "./googleAdsTarget";
import {
  buildGoogleAdsDailyQuery,
  validateGoogleAdsDailyFactsWindow,
  type GoogleAdsDailyAccountRow,
  type GoogleAdsDailyAdGroupRow,
  type GoogleAdsDailyCampaignRow,
  type GoogleAdsDailyDeviceRow,
  type GoogleAdsDailyFactsInput,
  type GoogleAdsDailyFactsResult,
  type GoogleAdsDailyKeywordRow,
  type GoogleAdsDailyLandingPageRow,
  type GoogleAdsDailySearchTermRow,
  type GoogleAdsReportingGrain,
} from "./googleAdsReporting";
import {
  extractGoogleAdsDailyAccountRow,
  extractGoogleAdsDailyAdGroupRow,
  extractGoogleAdsDailyCampaignRow,
  extractGoogleAdsDailyDeviceRow,
  extractGoogleAdsDailyKeywordRow,
  extractGoogleAdsDailyLandingPageRow,
  extractGoogleAdsDailySearchTermRow,
  type DailyRowParseResult,
} from "./googleAdsReporting.parsers";

/* Read-only Google Ads API v26 REST boundary (Phase 1: connection foundation).
 * Only explicit discovery reads are exposed — no mutate/SearchStream/query
 * endpoint exists on this client, mirroring the ga4Client contract. Contracts
 * are pinned to the v26 REST reference:
 * - GET  /v26/customers:listAccessibleCustomers → { resourceNames: [...] }
 * - POST /v26/customers/{id}/googleAds:search with { query, pageToken? } →
 *   { results: [...], nextPageToken?, fieldMask } (lowerCamelCase row JSON).
 *   pageSize must NOT be sent: it is deprecated in v26 and rejected with
 *   PAGE_SIZE_NOT_SUPPORTED (the API paginates at a fixed page size).
 * - The deprecated developer-token header is deliberately not sent: the token
 *   was sunset 2026-09-09 and API access now follows the OAuth Cloud project.
 * Errors are sanitized: Google's raw response body, request id and tokens are
 * never carried into thrown messages or logs, and untrusted errorCode text is
 * validated against an enum-style allowlist before being re-exposed. A
 * successful response that does not match the v26 schema becomes a bounded
 * GoogleAdsMalformedResponseError instead of a raw Zod error carrying
 * upstream values.
 *
 * Phase 2 adds the read-only Keyword Planner boundary on the same transport:
 * - POST /v26/customers/{id}:generateKeywordIdeas
 *   https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordIdeasRequest
 * - POST /v26/customers/{id}:generateKeywordHistoricalMetrics
 *   https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordHistoricalMetricsRequest
 * - POST /v26/geoTargetConstants:suggest
 *   https://developers.google.com/google-ads/api/reference/rpc/v26/SuggestGeoTargetConstantsRequest
 * Planner paging is its own contract (bounded pageSize, pageToken,
 * totalSize) and is NOT the Search endpoint's paging: a Search request still
 * sends no pageSize at all, and the historical-metrics endpoint has no paging
 * fields whatsoever. The metric and targeting semantics live in
 * googleAdsPlanner and googleAdsTarget so this file stays a transport.
 *
 * Phase 3 adds the fixed daily reporting reads on the same transport: seven
 * getDaily*Facts methods, each one fixed GAQL query per grain (account,
 * campaign, ad_group, keyword, search_term, device, landing_page) over an
 * inclusive segments.date window bounded to 37 months. No caller-supplied
 * GAQL, mutate/SearchStream/query endpoint or pageSize exists here; every
 * read pages with pageToken only, treats malformed rows as `partial`, and
 * the query construction and row parsers live in googleAdsReporting so this
 * file stays a transport. */

/** Pagination is server-controlled in v26 (fixed pages up to 10,000 rows).
 *  The client still imposes explicit traversal ceilings so every paid path
 *  stays bounded (Constitution P12); hitting either bound with more data
 *  available yields `truncated: true` — callers must surface partial
 *  discovery instead of treating it as the full hierarchy. */
export const GOOGLE_ADS_MAX_SEARCH_PAGES = 10;
export const GOOGLE_ADS_MAX_SEARCH_ROWS = GOOGLE_ADS_MAX_SEARCH_PAGES * 10_000;

const BASE_URL = `https://${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}`;

export class GoogleAdsTokenError extends Error {
  constructor(message = "Google Ads access token could not be minted.") {
    super(message);
    this.name = "GoogleAdsTokenError";
  }
}
export class GoogleAdsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAdsRequestError";
  }
}
export class GoogleAdsNotConnectedError extends Error {
  constructor(projectId: string) {
    super(`Google Ads is not connected for project ${projectId}.`);
    this.name = "GoogleAdsNotConnectedError";
  }
}
/** A successful HTTP response whose body does not match the documented v26
 *  schema. The upstream payload (and anything secret inside it) never
 *  reaches the message: the caller only learns the response was unusable. */
export class GoogleAdsMalformedResponseError extends Error {
  constructor(
    message = "Google Ads returned a response that does not match the expected v26 schema.",
  ) {
    super(message);
    this.name = "GoogleAdsMalformedResponseError";
  }
}
export class GoogleAdsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Canonical google.ads ErrorCode name (e.g.
     *  "AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION").
     *  Built ONLY from enum-style upstream keys/values (see
     *  sanitizeGoogleAdsErrorCode) so arbitrary response text can never be
     *  re-exposed. */
    public readonly googleAdsErrorCode?: string,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

function normalizeCustomerId(value: string): string {
  const normalized = normalizeGoogleAdsCustomerId(value);
  if (!normalized) {
    throw new GoogleAdsRequestError(
      "Google Ads customer IDs must be ten digits (with optional hyphen or space separators).",
    );
  }
  return normalized;
}

const listAccessibleCustomersSchema = z
  .object({
    resourceNames: z
      .array(z.string().regex(GOOGLE_ADS_CUSTOMER_RESOURCE_PATTERN))
      .optional(),
  })
  .passthrough();

const searchResponseSchema = z
  .object({
    // ProtoJSON omits empty repeated fields and a null behaves like
    // absence: an absent or null results list is an empty successful
    // page, while a present non-array is a malformed payload.
    results: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    nextPageToken: z.string().min(1).optional(),
    fieldMask: z.string().optional(),
  })
  .passthrough();

/** protobuf int64 fields arrive as JSON strings in REST; numbers are accepted
 *  defensively so either encoding normalizes identically. */
const int64ToString = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((value) => String(value));

const customerRowSchema = z
  .object({
    resourceName: z.string().regex(GOOGLE_ADS_CUSTOMER_RESOURCE_PATTERN),
    id: z.string().regex(GOOGLE_ADS_CUSTOMER_ID_PATTERN),
    descriptiveName: z.string().min(1).optional(),
    currencyCode: z.string().min(1).optional(),
    timeZone: z.string().min(1).optional(),
    manager: z.boolean().optional(),
    testAccount: z.boolean().optional(),
    status: z.string().min(1).optional(),
  })
  .passthrough();

const customerClientRowSchema = z
  .object({
    resourceName: z.string().min(1),
    clientCustomer: z.string().regex(GOOGLE_ADS_CUSTOMER_RESOURCE_PATTERN),
    id: z.string().regex(GOOGLE_ADS_CUSTOMER_ID_PATTERN),
    // REST renders customerClient.level (int64) as a string; the union cover
    // keeps numeric encodings valid too.
    level: int64ToString.transform((value) => Number(value)),
    hidden: z.boolean().optional(),
    manager: z.boolean().optional(),
    testAccount: z.boolean().optional(),
    status: z.string().min(1).optional(),
    descriptiveName: z.string().min(1).optional(),
    currencyCode: z.string().min(1).optional(),
    timeZone: z.string().min(1).optional(),
  })
  .passthrough();

export type GoogleAdsCustomer = {
  resourceName: string;
  customerId: string;
  /** Display form 123-456-7890 (formatting only; storage keeps bare digits). */
  formattedId: string;
  displayName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  isTestAccount: boolean;
  status: string | null;
};

export type GoogleAdsHierarchyEntry = {
  customerId: string;
  /** Root customer the traversal was run against (id, not resource name). */
  managerId: string;
  level: number;
  manager: boolean;
  hidden: boolean;
  testAccount: boolean;
  status: string | null;
  displayName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
};

export type GoogleAdsHierarchyResult = {
  entries: GoogleAdsHierarchyEntry[];
  /** True when the page/row ceiling was reached while nextPageToken still
   *  indicated more data — the returned entries are PARTIAL, not the full
   *  hierarchy. */
  truncated: boolean;
  /** Count of SUCCESSful search rows whose documented v26 nested
   *  `customerClient` shape failed validation. Malformed rows are skipped
   *  but never silently swallowed: callers must surface partial discovery
   *  when this count is nonzero (a COMPLETE-but-empty hierarchy can never
   *  be fabricated out of unparseable rows). */
  malformedRows: number;
  /** truncated || malformedRows > 0. The single truth flag for "these
   *  entries are NOT the full hierarchy" — never silently complete. */
  partial: boolean;
};

function normalizeCustomer(
  row: z.infer<typeof customerRowSchema>,
): GoogleAdsCustomer {
  return {
    resourceName: row.resourceName,
    customerId: row.id,
    formattedId: formatGoogleAdsCustomerId(row.id),
    displayName: row.descriptiveName ?? null,
    currencyCode: row.currencyCode ?? null,
    timeZone: row.timeZone ?? null,
    manager: row.manager ?? false,
    isTestAccount: row.testAccount ?? false,
    status: row.status ?? null,
  };
}

/** Google JSON error body shape (enough to sanitize safely; any value that
 *  fails the enum-style allowlist is dropped entirely). */
const googleErrorBodySchema = z
  .object({
    error: z
      .object({
        details: z
          .array(
            z
              .object({
                errors: z
                  .array(
                    z
                      .object({
                        errorCode: z.record(z.string(), z.unknown()).optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Upstream errorCode entries look like { authorizationError: "NAME..." }.
 *  Only the enum path re-enters app state: the key must look like
 *  "XxxError" and the value must be an UPPER_SNAKE enum literal. Anything
 *  else (HTML fragments, interpolations) is discarded. */
function sanitizeGoogleAdsErrorCode(
  errorCode: Record<string, unknown> | undefined,
): string | undefined {
  const entries = Object.entries(errorCode ?? {});
  for (const [key, value] of entries) {
    // Canonical google.ads error enum names are CamelCase
    // ("AuthorizationError.UPPER_SNAKE"); upstream keys are lowerCamel.
    if (!/^[A-Za-z]+Error$/.test(key)) continue;
    const canonicalKey = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    if (typeof value !== "string") continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) continue;
    return `${canonicalKey}.${value}`;
  }
  return undefined;
}

/** `Response.json()` is typed `any`; every upstream payload crosses the
 *  schema boundary as `unknown` so no upstream value is ever trusted.
 *  A body that is not JSON is a malformed upstream payload, not a transport
 *  failure: the raw parse error quotes the response bytes, so it is replaced
 *  by the bounded GoogleAdsMalformedResponseError and the body never leaks. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GoogleAdsMalformedResponseError();
  }
}

/** Error bodies are best-effort context: the HTTP status is the signal, so
 *  an unparseable body simply contributes no upstream error code instead of
 *  turning into a malformed-response failure. */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function parseApiError(response: Response): Promise<never> {
  const body = await readErrorBody(response);
  const parsed = googleErrorBodySchema.safeParse(body);
  const upstreamErrorCode = parsed.success
    ? parsed.data.error?.details?.[0]?.errors?.[0]?.errorCode
    : undefined;
  throw new GoogleAdsApiError(
    response.status,
    `Google Ads API error (${response.status}).`,
    sanitizeGoogleAdsErrorCode(upstreamErrorCode),
  );
}

function parseSearchResponse(
  payload: unknown,
): z.infer<typeof searchResponseSchema> {
  const parsed = searchResponseSchema.safeParse(payload);
  if (!parsed.success) throw new GoogleAdsMalformedResponseError();
  return parsed.data;
}

function parseCustomerRow(payload: unknown): GoogleAdsCustomer {
  const parsed = customerRowSchema.safeParse(payload);
  if (!parsed.success) throw new GoogleAdsMalformedResponseError();
  return normalizeCustomer(parsed.data);
}

/** Fixed GAQL queries — callers cannot inject arbitrary GAQL through this
 *  client. Snake_case inside GAQL; REST response rows are camelCase JSON. */
const CUSTOMER_QUERY = `
SELECT
  customer.id,
  customer.descriptive_name,
  customer.currency_code,
  customer.time_zone,
  customer.manager,
  customer.status,
  customer.test_account
FROM customer`;

const CUSTOMER_CLIENT_QUERY = `
SELECT
  customer_client.id,
  customer_client.client_customer,
  customer_client.level,
  customer_client.manager,
  customer_client.hidden,
  customer_client.status,
  customer_client.descriptive_name,
  customer_client.currency_code,
  customer_client.time_zone,
  customer_client.test_account
FROM customer_client`;

/** v26 REST request body. The Search endpoint takes the GAQL query plus an
 *  optional pageToken; `pageSize` is rejected by that API and is never sent.
 *  The Planner endpoints take their own documented bodies (bounded pageSize,
 *  pageToken and totalSize for the ideas endpoint; no paging fields at all
 *  for historical metrics). */
type AdsRequestBody = Record<string, unknown>;

export function createGoogleAdsClient(options: {
  userId: string;
  /** Google OAuth account id (`sub`) that owns the adwords grant. May be
   *  distinct from the customer ids being queried. */
  grantAccountId: string;
}) {
  async function getToken() {
    try {
      const result = await getAuth().api.getAccessToken({
        body: {
          providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
          userId: options.userId,
          accountId: options.grantAccountId,
        },
      });
      if (!result?.accessToken) throw new Error("No token");
      return result.accessToken;
    } catch {
      throw new GoogleAdsTokenError();
    }
  }

  /** Single transport seam for the Ads REST calls: bearer auth, the optional
   *  login-customer-id header, the pinned v26 URL and the sanitized error
   *  mapping live here so headers and bodies cannot drift between call
   *  sites. */
  async function adsRequest(
    path: string,
    request: {
      method: "GET" | "POST";
      body?: AdsRequestBody;
      loginCustomerId?: string | null;
    },
  ): Promise<Response> {
    const token = await getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (request.method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    if (request.loginCustomerId) {
      headers["login-customer-id"] = normalizeCustomerId(
        request.loginCustomerId,
      );
    }
    const response = await fetch(`${BASE_URL}${path}`, {
      method: request.method,
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    if (!response.ok) await parseApiError(response);
    return response;
  }

  function searchPath(customerId: string): string {
    return `/customers/${normalizeCustomerId(customerId)}/googleAds:search`;
  }

  async function search(
    customerId: string,
    query: string,
    input: { loginCustomerId?: string | null } = {},
  ): Promise<z.infer<typeof searchResponseSchema>> {
    const response = await adsRequest(searchPath(customerId), {
      method: "POST",
      body: { query },
      loginCustomerId: input.loginCustomerId ?? null,
    });
    return parseSearchResponse(await readJson(response));
  }

  /** Paginated bounded search: follows pageToken until the page or row
   *  ceiling is reached; returns `truncated: true` when data remains. A
   *  repeated token stops the traversal before the same page is requested
   *  again, so no row is collected twice and no page budget is burned. */
  async function searchBounded(
    customerId: string,
    query: string,
    loginCustomerId: string | null,
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
    lastPageToken: string | undefined;
  }> {
    const rows: Array<Record<string, unknown>> = [];
    const requestedTokens = new Set<string>();
    const path = searchPath(customerId);
    let pageToken: string | undefined;
    for (let page = 0; page < GOOGLE_ADS_MAX_SEARCH_PAGES; page += 1) {
      // v26 search accepts no explicit page count; only pageToken advances.
      const body: AdsRequestBody = { query };
      if (pageToken) body.pageToken = pageToken;
      const response = await adsRequest(path, {
        method: "POST",
        body,
        loginCustomerId,
      });
      const parsed = parseSearchResponse(await readJson(response));
      rows.push(...(parsed.results ?? []));
      if (rows.length >= GOOGLE_ADS_MAX_SEARCH_ROWS) {
        return {
          rows: rows.slice(0, GOOGLE_ADS_MAX_SEARCH_ROWS),
          truncated: Boolean(parsed.nextPageToken),
          lastPageToken: parsed.nextPageToken,
        };
      }
      const next = parsed.nextPageToken;
      if (!next) return { rows, truncated: false, lastPageToken: undefined };
      // The upstream repeated a token: requesting it again would replay the
      // same page and consume the whole page budget, so stop and report the
      // traversal as partial.
      if (requestedTokens.has(next)) {
        return { rows, truncated: true, lastPageToken: next };
      }
      requestedTokens.add(next);
      pageToken = next;
    }
    return { rows, truncated: true, lastPageToken: pageToken };
  }

  /** One `geoTargetConstants:suggest` call, shared by the raw suggestion
   *  read and the strict country resolver so both always send the same
   *  documented request. */
  async function suggestGeoTargets(
    request: GoogleAdsGeoTargetSuggestBody,
  ): Promise<GoogleAdsGeoTargetConstant[]> {
    const response = await adsRequest("/geoTargetConstants:suggest", {
      method: "POST",
      body: { ...request },
    });
    const parsed = parseGeoTargetSuggestions(await readJson(response));
    if (!parsed.ok) throw new GoogleAdsMalformedResponseError();
    return parsed.value.constants;
  }

  return {
    async listAccessibleCustomers(): Promise<string[]> {
      const response = await adsRequest("/customers:listAccessibleCustomers", {
        method: "GET",
      });
      const parsed = listAccessibleCustomersSchema.safeParse(
        await readJson(response),
      );
      if (!parsed.success) throw new GoogleAdsMalformedResponseError();
      return (parsed.data.resourceNames ?? []).map((resourceName) =>
        resourceName.slice("customers/".length),
      );
    },

    /** Fixed customer read. Returns null when the API returns no row. */
    async getCustomer(
      customerId: string,
      input: { loginCustomerId?: string | null } = {},
    ): Promise<GoogleAdsCustomer | null> {
      const parsed = await search(customerId, CUSTOMER_QUERY, input);
      const row = parsed.results?.[0];
      if (!row) return null;
      // v26 googleAds:search rows nest the selected resource under its
      // resource key (row.customer here). A flat row or a missing customer
      // field is a malformed successful payload — reject it instead of
      // fabricating a resourceName fallback.
      return parseCustomerRow(row.customer);
    },

    /** Manager-hierarchy traversal rooted at the queried customer, bounded
     *  and truncation-signaled. GET /googleAds:search reads only. */
    async listCustomerHierarchy(
      managerId: string,
      input: { loginCustomerId?: string | null } = {},
    ): Promise<GoogleAdsHierarchyResult> {
      const manager = normalizeCustomerId(managerId);
      const loginCustomerId = input.loginCustomerId
        ? normalizeCustomerId(input.loginCustomerId)
        : null;
      const { rows, truncated } = await searchBounded(
        manager,
        CUSTOMER_CLIENT_QUERY,
        loginCustomerId,
      );
      const entries: GoogleAdsHierarchyEntry[] = [];
      let malformedRows = 0;
      for (const row of rows) {
        const parsed = customerClientRowSchema.safeParse(row.customerClient);
        if (!parsed.success) {
          // A single malformed row must not abort discovery, but it is
          // NEVER silent: it is counted and surfaced via `partial` so an
          // unparseable successful payload can never masquerade as a
          // complete empty hierarchy.
          malformedRows += 1;
          continue;
        }
        entries.push({
          customerId: parsed.data.id,
          managerId: manager,
          level: parsed.data.level,
          manager: parsed.data.manager ?? false,
          hidden: parsed.data.hidden ?? false,
          testAccount: parsed.data.testAccount ?? false,
          status: parsed.data.status ?? null,
          displayName: parsed.data.descriptiveName ?? null,
          currencyCode: parsed.data.currencyCode ?? null,
          timeZone: parsed.data.timeZone ?? null,
        });
      }
      return {
        entries,
        truncated,
        malformedRows,
        partial: truncated || malformedRows > 0,
      };
    },

    /** Keyword ideas from a keyword seed, a URL seed or both. The request is
     *  bounded on every axis (seed size, geo constants, page size, total
     *  results, pages) and the result says whether it is the complete set:
     *  `truncated` and `partial` are never silently false. */
    async generateKeywordIdeas(
      input: GoogleAdsKeywordIdeasInput,
    ): Promise<GoogleAdsKeywordIdeasResult> {
      const request = buildKeywordIdeasRequest(input);
      if (!request.ok) throw new GoogleAdsRequestError(request.reason);
      const customerId = normalizeCustomerId(input.customerId);
      const loginCustomerId = input.loginCustomerId
        ? normalizeCustomerId(input.loginCustomerId)
        : null;
      const path = `/customers/${customerId}:generateKeywordIdeas`;
      const collected = await collectKeywordRecords({
        fetchPage: async (pageToken) => {
          const body: AdsRequestBody = { ...request.value.body };
          if (pageToken) body.pageToken = pageToken;
          const response = await adsRequest(path, {
            method: "POST",
            body,
            loginCustomerId,
          });
          return parseIdeasPage(await readJson(response));
        },
        maxResults: request.value.maxResults,
        maxPages: request.value.maxPages,
      });
      if (!collected.ok) throw new GoogleAdsMalformedResponseError();
      return {
        ideas: collected.value.records,
        totalResults: collected.value.totalResults,
        truncated: collected.value.truncated,
        malformedIdeas: collected.value.malformedRecords,
        partial:
          collected.value.truncated || collected.value.malformedRecords > 0,
        source: GOOGLE_ADS_PLANNER_SOURCE,
        fetchedAt: new Date().toISOString(),
        currencyCode: request.value.currencyCode,
        network: GOOGLE_ADS_DEFAULT_PLANNER_NETWORK,
      };
    },

    /** Historical metrics for a bounded list of keywords. Close variants stay
     *  one record with membership, and a keyword Google returned no group for
     *  is reported as missing — never as a zero-volume keyword. */
    async generateKeywordHistoricalMetrics(
      input: GoogleAdsHistoricalMetricsInput,
    ): Promise<GoogleAdsHistoricalMetricsResult> {
      const request = buildHistoricalMetricsRequest(input);
      if (!request.ok) throw new GoogleAdsRequestError(request.reason);
      const customerId = normalizeCustomerId(input.customerId);
      const loginCustomerId = input.loginCustomerId
        ? normalizeCustomerId(input.loginCustomerId)
        : null;
      const response = await adsRequest(
        `/customers/${customerId}:generateKeywordHistoricalMetrics`,
        {
          method: "POST",
          body: request.value.body,
          loginCustomerId,
        },
      );
      const parsed = parseHistoricalPage(await readJson(response));
      if (!parsed.ok) throw new GoogleAdsMalformedResponseError();
      const covered = new Set<string>();
      for (const record of parsed.value.records) {
        covered.add(record.keyword);
        for (const variant of record.closeVariants) covered.add(variant);
      }
      const missingKeywords = request.value.keywords.filter(
        (keyword) => !covered.has(keyword),
      );
      return {
        keywords: parsed.value.records,
        missingKeywords,
        malformedKeywords: parsed.value.malformedRecords,
        duplicateKeywords: parsed.value.duplicateRecords,
        // The historical-metrics endpoint has no paging contract.
        truncated: false,
        partial:
          parsed.value.malformedRecords > 0 || missingKeywords.length > 0,
        source: GOOGLE_ADS_PLANNER_SOURCE,
        fetchedAt: new Date().toISOString(),
        currencyCode: request.value.currencyCode,
        network: GOOGLE_ADS_DEFAULT_PLANNER_NETWORK,
      };
    },

    /** The raw geo target suggestions for one country name. Nothing here
     *  guesses an id: a Google geo target constant is only ever resolved
     *  through the documented suggest call. */
    async suggestGeoTargetConstants(
      input: GoogleAdsGeoTargetSuggestInput,
    ): Promise<GoogleAdsGeoTargetConstant[]> {
      const request = buildGeoTargetSuggestRequest(input);
      if (!request.ok) throw new GoogleAdsRequestError(request.reason);
      return suggestGeoTargets(request.value);
    },

    /** Resolves one country to its Google geo target constant resource name.
     *  A country that is unknown, disabled or ambiguous is rejected — the
     *  client never substitutes a different country. */
    async resolveCountryGeoTargetConstant(
      input: GoogleAdsGeoTargetSuggestInput,
    ): Promise<GoogleAdsGeoTargetConstant> {
      const request = buildGeoTargetSuggestRequest(input);
      if (!request.ok) throw new GoogleAdsRequestError(request.reason);
      const constants = await suggestGeoTargets(request.value);
      const selected = selectCountryGeoTargetConstant(
        constants,
        request.value.countryCode,
      );
      if (!selected.ok) throw new GoogleAdsRequestError(selected.reason);
      return selected.value;
    },

    /** Resolves one language code to its Google language constant resource
     *  name with a fixed, validated search on the selected customer. An
     *  unknown or ambiguous language is rejected; English is never assumed. */
    async resolveLanguageConstant(
      input: GoogleAdsLanguageConstantInput,
    ): Promise<GoogleAdsLanguageConstant> {
      const query = buildLanguageConstantQuery(input.languageCode);
      if (!query.ok) throw new GoogleAdsRequestError(query.reason);
      const customerId = normalizeCustomerId(input.customerId);
      const loginCustomerId = input.loginCustomerId
        ? normalizeCustomerId(input.loginCustomerId)
        : null;
      const response = await adsRequest(searchPath(customerId), {
        method: "POST",
        body: { query: query.value },
        loginCustomerId,
      });
      const parsed = parseLanguageConstants(await readJson(response));
      if (!parsed.ok) throw new GoogleAdsMalformedResponseError();
      const selected = selectLanguageConstant(
        parsed.value.constants,
        input.languageCode.trim(),
      );
      if (!selected.ok) throw new GoogleAdsRequestError(selected.reason);
      return selected.value;
    },

    // Fixed daily reporting reads (Phase 3): their method shapes live in
    // createDailyFactsMethods below so the factory stays within its
    // size budget; here they are only wired to the bounded Search closure.
    ...createDailyFactsMethods(searchBounded),
  };
}

/** Fixed daily-facts method shapes: one documented v26 query per grain
 *  (account, campaign, ad_group, keyword, search_term, device,
 *  landing_page), validated window, no caller-supplied GAQL and no
 *  pageSize. Segmented rows are parsed per grain; malformed rows surface
 *  via `partial`, and absent segmented rows (the zero-metrics contract)
 *  are a valid empty read, not a failure. */
function createDailyFactsMethods(
  searchBounded: (
    customerId: string,
    query: string,
    loginCustomerId: string | null,
  ) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>,
) {
  /** Shared bounded daily-facts runner: the window is validated BEFORE
   *  any auth work, the fixed per-grain query is then built, and Search
   *  pages under the existing ceilings. Rows are parsed per grain;
   *  malformed rows surface as `partial`, never as success-complete data. */
  const runDailyFacts = async <Row>(
    grain: GoogleAdsReportingGrain,
    input: GoogleAdsDailyFactsInput,
    extractRow: (row: unknown) => DailyRowParseResult<Row>,
  ): Promise<GoogleAdsDailyFactsResult<Row>> => {
    const window = validateGoogleAdsDailyFactsWindow(input);
    if (!window.ok) throw new GoogleAdsRequestError(window.reason);
    const built = buildGoogleAdsDailyQuery(grain, input);
    if (!built.ok) throw new GoogleAdsRequestError(built.reason);
    const { rows, truncated } = await searchBounded(
      window.value.customerId,
      built.value,
      window.value.loginCustomerId,
    );
    let malformedRows = 0;
    const facts: Row[] = [];
    for (const row of rows) {
      const parsed = extractRow(row);
      if (!parsed.ok) {
        // A malformed row in a successful payload is never silent: it is
        // counted and surfaced via `partial`, mirroring the hierarchy
        // traversal so incomplete data cannot pass as complete.
        malformedRows += 1;
        continue;
      }
      facts.push(parsed.value);
    }
    return {
      grain,
      customerId: window.value.customerId,
      startDate: window.value.startDate,
      endDate: window.value.endDate,
      metricDateBasis: "interaction_date",
      source: "google_ads",
      fetchedAt: new Date().toISOString(),
      rows: facts,
      truncated,
      malformedRows,
      partial: truncated || malformedRows > 0,
    };
  };

  return {
    async getDailyAccountFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyAccountRow>> {
      return runDailyFacts("account", input, extractGoogleAdsDailyAccountRow);
    },

    async getDailyCampaignFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyCampaignRow>> {
      return runDailyFacts("campaign", input, extractGoogleAdsDailyCampaignRow);
    },

    async getDailyAdGroupFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyAdGroupRow>> {
      return runDailyFacts("ad_group", input, extractGoogleAdsDailyAdGroupRow);
    },

    async getDailyKeywordFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyKeywordRow>> {
      return runDailyFacts("keyword", input, extractGoogleAdsDailyKeywordRow);
    },

    async getDailySearchTermFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailySearchTermRow>> {
      return runDailyFacts(
        "search_term",
        input,
        extractGoogleAdsDailySearchTermRow,
      );
    },

    async getDailyDeviceFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyDeviceRow>> {
      return runDailyFacts("device", input, extractGoogleAdsDailyDeviceRow);
    },

    async getDailyLandingPageFacts(
      input: GoogleAdsDailyFactsInput,
    ): Promise<GoogleAdsDailyFactsResult<GoogleAdsDailyLandingPageRow>> {
      return runDailyFacts(
        "landing_page",
        input,
        extractGoogleAdsDailyLandingPageRow,
      );
    },
  };
}

export type GoogleAdsErrorClassification = {
  errorClass: string;
  message: string;
  retryable: boolean;
};

/** v26 AuthorizationError enum members meaning the linked Google Cloud
 *  project is not cleared for production Ads API access. */
const RESTRICTED_ERROR_CODES = new Set([
  "AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
]);

/** v26 AuthorizationError members meaning the Cloud project may not use the
 *  requested Google Ads API service at all (official v26 text: "The developer
 *  specified does not have access to the service"). Access-level restrictions
 *  are conditional per service — for example, Explorer access excludes
 *  KeywordPlanIdeaService for Planner calls — so the message stays generic
 *  about the requested service. It is a Cloud access restriction, NOT an
 *  expired or revoked OAuth grant.
 *  https://developers.google.com/google-ads/api/reference/rpc/v26/AuthorizationErrorEnum.AuthorizationError */
const SERVICE_ACCESS_DENIED_ERROR_CODES = new Set([
  "AuthorizationError.SERVICE_ACCESS_DENIED",
]);

/** v26 Authorization/Authentication members that describe Cloud project or
 *  Cloud organization access rather than the lifetime of the OAuth grant. */
const CLOUD_ACCESS_ERROR_CODES = new Set([
  "AuthorizationError.PROJECT_DISABLED",
  "AuthorizationError.CLOUD_PROJECT_NOT_UNDER_ORGANIZATION",
  "AuthorizationError.INCOMPLETE_SIGNUP",
  "AuthorizationError.MISSING_TOS",
  "AuthenticationError.ORGANIZATION_NOT_APPROVED",
  "AuthenticationError.ORGANIZATION_NOT_RECOGNIZED",
]);

/** v26 AuthenticationError enum members meaning the OAuth grant itself is
 *  unusable — only a reconnect fixes them. */
const OAUTH_TOKEN_ERROR_CODES = new Set([
  "AuthenticationError.OAUTH_TOKEN_INVALID",
  "AuthenticationError.OAUTH_TOKEN_EXPIRED",
  "AuthenticationError.OAUTH_TOKEN_REVOKED",
  "AuthenticationError.OAUTH_TOKEN_DISABLED",
]);

/** 5xx statuses worth another attempt; 501/505 are not transient. */
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

/** Deterministic, non-revealing classification. Quota exhaustion is split
 *  from access restrictions: only the documented temporary quota enum and
 *  transient 5xx are retryable, while persistent quota, account permission,
 *  Cloud project restrictions and invalid/expired/revoked OAuth are not.
 *  Upstream enums re-exposed here are always the sanitized canonical
 *  strings from GoogleAdsApiError. */
export function classifyGoogleAdsError(
  error: unknown,
): GoogleAdsErrorClassification {
  if (error instanceof GoogleAdsTokenError) {
    return {
      errorClass: "OAUTH_TOKEN_FAILURE",
      // The token mint itself failed, so the cause is unknown: no expired or
      // revoked grant is asserted without evidence from the upstream.
      message:
        "The Google Ads OAuth access token could not be obtained. Reconnect the Google account and try again.",
      retryable: false,
    };
  }
  if (error instanceof GoogleAdsMalformedResponseError) {
    return {
      errorClass: "MALFORMED_RESPONSE",
      message:
        "Google Ads returned a response that does not match the expected schema.",
      retryable: false,
    };
  }
  if (error instanceof GoogleAdsRequestError) {
    return {
      errorClass: "INVALID_REQUEST",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof GoogleAdsNotConnectedError) {
    return {
      errorClass: "NOT_CONNECTED",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof GoogleAdsApiError) {
    const code = error.googleAdsErrorCode;
    if (code && OAUTH_TOKEN_ERROR_CODES.has(code)) {
      return {
        errorClass: "OAUTH_TOKEN_INVALID",
        message:
          "Google Ads rejected the OAuth token (invalid, expired, revoked or disabled). Reconnect the account.",
        retryable: false,
      };
    }
    if (code && RESTRICTED_ERROR_CODES.has(code)) {
      return {
        errorClass: "API_ACCESS_RESTRICTED",
        message:
          "The Google Cloud project backing this connection is not approved for Google Ads production API access.",
        retryable: false,
      };
    }
    if (code && SERVICE_ACCESS_DENIED_ERROR_CODES.has(code)) {
      return {
        errorClass: "API_ACCESS_RESTRICTED",
        message:
          "This Google Ads Cloud project does not have access to the requested Google Ads API service (for example, Explorer access excludes the Keyword Planner service). Fix the Cloud project's access level for the calls being made.",
        retryable: false,
      };
    }
    if (code && CLOUD_ACCESS_ERROR_CODES.has(code)) {
      return {
        errorClass: "API_ACCESS_RESTRICTED",
        message:
          "The Google Cloud project backing this connection is not cleared for Google Ads API access.",
        retryable: false,
      };
    }
    if (
      code === "QuotaError.RESOURCE_TEMPORARILY_EXHAUSTED" ||
      code === "QuotaError.EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION"
    ) {
      return {
        errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
        message:
          "Google Ads API quota is temporarily exhausted. Retry shortly.",
        retryable: true,
      };
    }
    if (
      code === "QuotaError.RESOURCE_EXHAUSTED" ||
      code === "QuotaError.EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION" ||
      error.status === 429
    ) {
      return {
        errorClass: "QUOTA_EXHAUSTED",
        message:
          "Google Ads API quota exhausted. The quota window must reset before another attempt can succeed.",
        retryable: false,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        errorClass: "PERMISSION_DENIED",
        message: "Google Ads permission denied for this account.",
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        errorClass: "CUSTOMER_NOT_FOUND",
        message: "Google Ads customer not found.",
        retryable: false,
      };
    }
    if (error.status === 400) {
      return {
        errorClass: "INVALID_REQUEST",
        message: `Google Ads invalid request: ${error.message}`,
        retryable: false,
      };
    }
    return {
      errorClass: `HTTP_ERROR_${error.status}`,
      message: error.message,
      retryable: RETRYABLE_HTTP_STATUSES.has(error.status),
    };
  }
  return {
    errorClass: "SYNC_FAILURE",
    message: "Unknown failure during Google Ads operation.",
    retryable: false,
  };
}
