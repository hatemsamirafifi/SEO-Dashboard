/* eslint-disable max-lines */
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

const accountSummariesSchema = z
  .object({
    accountSummaries: z
      .array(
        z
          .object({
            account: z.string().regex(/^accounts\/[^/]+$/),
            propertySummaries: z
              .array(
                z
                  .object({
                    property: z.string().regex(/^properties\/[^/]+$/),
                    displayName: z.string().min(1),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .passthrough();

export type Ga4Property = {
  propertyId: string;
  displayName: string;
  currencyCode: string | null;
};

export class Ga4TokenError extends Error {}
/** No GA4 property is connected for the project. Defined beside the other
 *  client error types (rather than in Ga4Service) so the error taxonomy can
 *  classify it without an import cycle. */
export class Ga4NotConnectedError extends Error {
  constructor(projectId: string) {
    super(`Google Analytics is not connected for project ${projectId}.`);
    this.name = "Ga4NotConnectedError";
  }
}
export class Ga4ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Google API numeric status (e.g. 8 = RESOURCE_EXHAUSTED), when present. */
    public readonly apiStatus?: number,
  ) {
    super(message);
  }
}
/** A caller-supplied report request referenced a dimension or metric outside
 *  the allowlist — rejected before any HTTP call is made. */
export class Ga4RequestError extends Error {}

/** Allowlisted Data API dimensions (final-plan §9.4 taxonomy). Requests
 *  referencing anything else are rejected client-side. deviceCategory +
 *  country arrived with the analytics filter contract; browser +
 *  operatingSystem arrived with the technology grain (spec 002). */
const ALLOWED_DIMENSIONS = new Set([
  "date",
  "sessionDefaultChannelGroup",
  "sessionSource",
  "sessionMedium",
  "landingPagePlusQueryString",
  "eventName",
  "deviceCategory",
  "country",
  "browser",
  "operatingSystem",
]);

/** Allowlisted Data API metrics. Revenue + key-event metrics arrived with
 *  the Task 3 sync scope (fixture-verified; live calibration external). */
const ALLOWED_METRICS = new Set([
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  "screenPageViews",
  "eventCount",
  "newUsers",
  "activeUsers",
  "totalUsers",
  "keyEvents",
  "totalRevenue",
  "purchaseRevenue",
  "transactions",
  "addToCarts",
  "checkouts",
]);

const ga4OrderBySchema = z
  .object({ name: z.string().min(1), desc: z.boolean().optional() })
  .strict();

const ga4ReportRequestSchema = z
  .object({
    propertyId: z.string().regex(/^\d+$/),
    dateRanges: z
      .array(z.object({ startDate: z.string(), endDate: z.string() }).strict())
      .min(1)
      .max(3),
    dimensions: z.array(z.string().min(1)).max(9).default([]),
    metrics: z.array(z.string().min(1)).min(1).max(9),
    dimensionFilter: z.unknown().optional(),
    orderBys: z.array(ga4OrderBySchema).optional(),
    limit: z.number().int().positive().max(100_000).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export type Ga4ReportRequest = z.infer<typeof ga4ReportRequestSchema>;

const ga4RunReportResponseSchema = z
  .object({
    dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
    metricHeaders: z.array(z.object({ name: z.string() })).optional(),
    rows: z
      .array(
        z.object({
          dimensionValues: z.array(z.object({ value: z.string() })).optional(),
          metricValues: z
            .array(z.object({ value: z.string() }).passthrough())
            .optional(),
        }),
      )
      .optional(),
    rowCount: z.number().int().nonnegative().optional(),
    metadata: z
      .object({
        samplingMetadatas: z
          .array(
            z.object({
              samplesReadCount: z.string().optional(),
              samplingSpaceSize: z.string().optional(),
            }),
          )
          .optional(),
        currencyCode: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Ga4ReportResult = {
  rowCount: number;
  rows: Array<{ dimensionValues: string[]; metricValues: number[] }>;
  metadata: {
    samplingState: "SAMPLED" | "NOT_SAMPLED";
    isTruncated: boolean;
    currencyCode: string | null;
  };
};

/** Canonical normalized-report schema. Reused by cache readers so cached
 *  payloads validate against the exact contract (drift = miss). */
export const ga4ReportResultSchema: z.ZodType<Ga4ReportResult> = z.object({
  rowCount: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      dimensionValues: z.array(z.string()),
      metricValues: z.array(z.number()),
    }),
  ),
  metadata: z.object({
    samplingState: z.enum(["SAMPLED", "NOT_SAMPLED"]),
    isTruncated: z.boolean(),
    currencyCode: z.string().nullable(),
  }),
});

const ga4BatchErrorSchema = z
  .object({
    code: z.number().int().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const ga4BatchResponseSchema = z
  .object({
    reports: z.array(z.unknown()).optional(),
  })
  .passthrough();

const API_ERROR_STATUS_CODES: Record<string, number> = {
  RESOURCE_EXHAUSTED: 8,
  INVALID_ARGUMENT: 3,
  PERMISSION_DENIED: 7,
  NOT_FOUND: 5,
  ABORTED: 10,
  INTERNAL: 13,
  UNAVAILABLE: 14,
};

async function parseApiError(response: Response): Promise<never> {
  const parsed = z
    .object({
      error: z
        .object({
          status: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .safeParse(await response.json().catch(() => null));
  const status = parsed.success ? parsed.data.error?.status : undefined;
  throw new Ga4ApiError(
    response.status,
    `Google Analytics Data API error (${response.status}).`,
    status ? API_ERROR_STATUS_CODES[status] : undefined,
  );
}

function normalizeRunReportResponse(
  parsed: z.infer<typeof ga4RunReportResponseSchema>,
): Ga4ReportResult {
  const truncated = parsed.metadata?.samplingMetadatas?.[0];
  const samplingState =
    truncated &&
    truncated.samplesReadCount &&
    truncated.samplingSpaceSize &&
    truncated.samplesReadCount !== truncated.samplingSpaceSize
      ? ("SAMPLED" as const)
      : ("NOT_SAMPLED" as const);
  return {
    rowCount: parsed.rowCount ?? parsed.rows?.length ?? 0,
    rows: (parsed.rows ?? []).map((row) => ({
      dimensionValues: (row.dimensionValues ?? []).map((v) => v.value),
      metricValues: (row.metricValues ?? []).map((v) => Number(v.value)),
    })),
    metadata: {
      samplingState,
      isTruncated: false,
      currencyCode: parsed.metadata?.currencyCode ?? null,
    },
  };
}

const ga4PropertySchema = z
  .object({ createTime: z.string().min(1).optional() })
  .passthrough();

function assertAllowlisted(request: Ga4ReportRequest) {
  for (const dimension of request.dimensions) {
    if (!ALLOWED_DIMENSIONS.has(dimension))
      throw new Ga4RequestError(
        `Dimension "${dimension}" is not on the GA4 allowlist.`,
      );
  }
  for (const metric of request.metrics) {
    if (!ALLOWED_METRICS.has(metric))
      throw new Ga4RequestError(
        `Metric "${metric}" is not on the GA4 allowlist.`,
      );
  }
  for (const orderBy of request.orderBys ?? []) {
    if (
      !ALLOWED_DIMENSIONS.has(orderBy.name) &&
      !ALLOWED_METRICS.has(orderBy.name)
    )
      throw new Ga4RequestError(
        `Order-by "${orderBy.name}" is not on the GA4 allowlist.`,
      );
  }
}

function toRunReportBody(request: Ga4ReportRequest) {
  return {
    dateRanges: request.dateRanges,
    dimensions: request.dimensions.map((name) => ({ name })),
    metrics: request.metrics.map((name) => ({ name })),
    dimensionFilter: request.dimensionFilter,
    orderBys: request.orderBys?.map((orderBy) => ({
      desc: orderBy.desc ?? false,
      ...(ALLOWED_METRICS.has(orderBy.name)
        ? { metric: { metricName: orderBy.name } }
        : { dimension: { dimensionName: orderBy.name } }),
    })),
    limit: request.limit,
    offset: request.offset,
  };
}

/** Minimal Admin API boundary plus the Data API reporting surface. */
export function createGa4Client(options: {
  userId: string;
  ga4AccountId: string;
}) {
  async function getToken() {
    try {
      const result = await getAuth().api.getAccessToken({
        body: {
          providerId: GA4_OAUTH_PROVIDER_ID,
          userId: options.userId,
          accountId: options.ga4AccountId,
        },
      });
      if (!result?.accessToken) throw new Error("No token");
      return result.accessToken;
    } catch (cause) {
      throw new Ga4TokenError(
        "Could not mint a Google Analytics access token (grant revoked or expired).",
        { cause },
      );
    }
  }

  async function postJson(url: string, body: unknown) {
    const token = await getToken();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) await parseApiError(response);
    return response.json();
  }

  return {
    async listProperties(): Promise<Ga4Property[]> {
      const token = await getToken();
      const properties: Ga4Property[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok)
          throw new Ga4ApiError(
            response.status,
            `Google Analytics Admin API error (${response.status}).`,
          );
        const parsed = accountSummariesSchema.parse(await response.json());
        for (const account of parsed.accountSummaries ?? []) {
          for (const property of account.propertySummaries ?? []) {
            properties.push({
              propertyId: property.property.slice("properties/".length),
              displayName: property.displayName,
              currencyCode: null,
            });
          }
        }
        pageToken = parsed.nextPageToken;
      } while (pageToken);
      return properties;
    },

    /** Property creation date (`YYYY-MM-DD`) for initial-window clamping, or
     *  null when the Admin API does not return a usable createTime. HTTP
     *  failures propagate as classified Ga4ApiError (never silent). */
    async getPropertyCreateTime(propertyId: string): Promise<string | null> {
      const token = await getToken();
      const response = await fetch(
        `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok)
        throw new Ga4ApiError(
          response.status,
          `Google Analytics Admin API error (${response.status}).`,
        );
      const parsed = ga4PropertySchema.parse(await response.json());
      const match = parsed.createTime?.slice(0, 10) ?? null;
      return match && /^\d{4}-\d{2}-\d{2}$/.test(match) ? match : null;
    },

    async runReport(request: Ga4ReportRequest): Promise<Ga4ReportResult> {
      const parsed = ga4ReportRequestSchema.parse(request);
      assertAllowlisted(parsed);
      const raw = await postJson(
        `https://analyticsdata.googleapis.com/v1beta/properties/${parsed.propertyId}:runReport`,
        toRunReportBody(parsed),
      );
      return normalizeRunReportResponse(ga4RunReportResponseSchema.parse(raw));
    },

    async batchRunReports(
      requests: Ga4ReportRequest[],
    ): Promise<Array<Ga4ReportResult | Ga4ApiError>> {
      if (requests.length === 0) {
        throw new Ga4RequestError(
          "batchRunReports requires at least one sub-request.",
        );
      }
      const parsed = requests.map((request) => {
        const validated = ga4ReportRequestSchema.parse(request);
        assertAllowlisted(validated);
        return validated;
      });
      const propertyId = parsed[0]?.propertyId;
      const raw = ga4BatchResponseSchema.parse(
        await postJson(
          `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`,
          { requests: parsed.map(toRunReportBody) },
        ),
      );
      return (raw.reports ?? []).map((report) => {
        const asError = ga4BatchErrorSchema.safeParse(
          typeof report === "object" && report !== null && "error" in report
            ? (report as { error: unknown }).error
            : undefined,
        );
        if (asError.success) {
          const { code, message, status } = asError.data;
          return new Ga4ApiError(
            code ?? 400,
            `Google Analytics Data API sub-request error: ${message ?? "unknown"}`,
            status ? API_ERROR_STATUS_CODES[status] : undefined,
          );
        }
        return normalizeRunReportResponse(
          ga4RunReportResponseSchema.parse(report),
        );
      });
    },
  };
}

export type Ga4ErrorClassification = {
  errorClass: string;
  message: string;
  retryable: boolean;
};

export function classifyGa4Error(error: unknown): Ga4ErrorClassification {
  if (error instanceof Ga4TokenError) {
    return {
      errorClass: "OAUTH_TOKEN_FAILURE",
      message:
        error.message || "Google Analytics OAuth grant expired or revoked.",
      retryable: false,
    };
  }
  if (error instanceof Ga4RequestError) {
    return {
      errorClass: "INVALID_REQUEST",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof Ga4NotConnectedError) {
    return {
      errorClass: "NOT_CONNECTED",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof Ga4ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        errorClass: "PERMISSION_DENIED",
        message: "Google Analytics permission denied for this property.",
        retryable: false,
      };
    }
    if (error.status === 404) {
      return {
        errorClass: "PROPERTY_NOT_FOUND",
        message: "Google Analytics property not found.",
        retryable: false,
      };
    }
    if (error.status === 429 || error.apiStatus === 8) {
      return {
        errorClass: "QUOTA_EXHAUSTED",
        message:
          "Google Analytics Data API quota exhausted. Retry after the quota window.",
        retryable: true,
      };
    }
    if (error.status === 400) {
      return {
        errorClass: "INVALID_REQUEST",
        message: `Google Analytics invalid request: ${error.message}`,
        retryable: false,
      };
    }
    const retryable = error.status >= 500;
    return {
      errorClass: `HTTP_ERROR_${error.status}`,
      message: error.message,
      retryable,
    };
  }
  if (error instanceof Error) {
    return {
      errorClass: "SYNC_FAILURE",
      message: error.message,
      retryable: false,
    };
  }
  return {
    errorClass: "SYNC_FAILURE",
    message: "Unknown failure during Google Analytics operation.",
    retryable: false,
  };
}
