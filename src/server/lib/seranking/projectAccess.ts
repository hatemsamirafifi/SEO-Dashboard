import { AppError } from "@/server/lib/errors";
import type { SeRankingClient } from "./client";
import {
  SeRankingAuthError,
  SeRankingCreditExhaustedError,
  SeRankingNotFoundError,
  SeRankingRateLimitError,
  SeRankingUpstreamError,
  SeRankingValidationError,
} from "./errors";
import {
  seRankingSiteEngineSchema,
  seRankingSiteSchema,
  type SeRankingSite,
} from "./projectSchemas";

export interface ProjectQuotaDimension {
  status: "ok" | "unknown" | "blocked" | "rate_limited";
  limit: number | "unknown";
  used: number | "unknown";
  remaining: number | "unknown";
  source:
    | "provider_reported"
    | "inferred_from_sites"
    | "unavailable"
    | "provider_error";
  detail?: string;
}

export interface ProjectApiAccessReport {
  sites: SeRankingSite[];
  apiAuth: {
    status: "ok" | "unauthenticated";
    source: "users_me" | "sites_list";
    accountEmail?: string;
    detail?: string;
  };
  projectApi: {
    accessible: boolean;
    status: "ok" | "blocked";
    detail?: string;
  };
  projectSubscription: {
    status: "active" | "unknown" | "blocked";
    detail?: string;
  };
  projectCapacity: ProjectQuotaDimension;
  trackedKeywordCapacity: ProjectQuotaDimension;
  deviceLocationAllocations: {
    status: "ok" | "unknown" | "blocked";
    verifiedEngineCount?: number;
    detail?: string;
  };
  recheckRestrictions: {
    status: "ok" | "unknown" | "blocked" | "rate_limited";
    detail?: string;
  };
}

export type ProjectApiOperation =
  | "access"
  | "site_create"
  | "engine_create"
  | "keyword_sync"
  | "recheck";

/**
 * Returns true if an error reflects transient connectivity, upstream 5xx,
 * timeout, or rate-limit pressure rather than changed credentials or access revocation.
 */
export function isTransientSeRankingError(error: unknown): boolean {
  if (error instanceof SeRankingRateLimitError) return true;
  if (error instanceof SeRankingUpstreamError) return true;
  if (error instanceof AppError) {
    return (
      error.code === "RATE_LIMITED" ||
      error.code === "TRANSIENT_UPSTREAM" ||
      error.code === "UPSTREAM_UNAVAILABLE"
    );
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("econnreset") ||
      msg.includes("fetch failed") ||
      msg.includes("network")
    );
  }
  return false;
}

/**
 * Classify SE Ranking Project Management API failures cleanly across auth,
 * API access, subscription limits, keyword/engine/project caps, and recheck cooldowns.
 */
export function classifyProjectApiError(
  error: unknown,
  operation: ProjectApiOperation,
): Error {
  if (error instanceof AppError) return error;

  if (error instanceof SeRankingAuthError) {
    if (error.upstreamStatus === 401) {
      return new AppError(
        "UNAUTHENTICATED",
        "PROJECT_API_AUTH_FAILED: SE Ranking API key rejected during Project API check.",
        { dimension: "api_auth", operation },
      );
    }
    return new AppError(
      "FORBIDDEN",
      "PROJECT_API_ACCESS_REQUIRED: SE Ranking Project Management API access is required for this key/plan.",
      { dimension: "project_api", operation },
    );
  }

  if (error instanceof SeRankingRateLimitError) {
    return new AppError(
      "RATE_LIMITED",
      error.message ||
        "SE Ranking Project API rate limit or recheck cooldown reached.",
      {
        dimension:
          operation === "recheck" ? "recheck_restrictions" : "project_api",
        operation,
      },
    );
  }

  if (isTransientSeRankingError(error)) {
    const msg = error instanceof Error ? error.message : String(error);
    return new AppError("TRANSIENT_UPSTREAM", msg, {
      dimension: "project_api",
      operation,
    });
  }

  if (
    error instanceof SeRankingCreditExhaustedError ||
    error instanceof SeRankingValidationError
  ) {
    const lower = error.message.toLowerCase();
    if (
      operation === "recheck" &&
      (lower.includes("recheck") ||
        lower.includes("cooldown") ||
        lower.includes("frequently") ||
        lower.includes("frequency") ||
        lower.includes("limit") ||
        lower.includes("quota"))
    ) {
      return new AppError(
        "PAYMENT_REQUIRED",
        `PROJECT_API_RECHECK_RESTRICTED: ${error.message}`,
        {
          dimension: "recheck_restrictions",
          operation,
        },
      );
    }
    if (lower.includes("keyword")) {
      return new AppError(
        "PAYMENT_REQUIRED",
        `PROJECT_API_KEYWORD_CAPACITY_EXCEEDED: ${error.message}`,
        { dimension: "tracked_keyword_capacity", operation },
      );
    }
    if (
      operation === "engine_create" ||
      lower.includes("search engine") ||
      lower.includes("engine") ||
      lower.includes("location") ||
      lower.includes("region")
    ) {
      return new AppError(
        "PAYMENT_REQUIRED",
        `PROJECT_API_ENGINE_ALLOCATION_EXCEEDED: ${error.message}`,
        { dimension: "device_location_allocations", operation },
      );
    }
    if (
      operation === "site_create" &&
      (lower.includes("site") ||
        lower.includes("project") ||
        lower.includes("limit") ||
        lower.includes("quota"))
    ) {
      return new AppError(
        "PAYMENT_REQUIRED",
        `PROJECT_API_PROJECT_LIMIT_EXCEEDED: ${error.message}`,
        { dimension: "project_capacity", operation },
      );
    }
    if (error instanceof SeRankingCreditExhaustedError) {
      return new AppError(
        "PAYMENT_REQUIRED",
        `PROJECT_API_SUBSCRIPTION_BLOCKED: ${error.message}`,
        { dimension: "project_subscription", operation },
      );
    }
  }

  return error instanceof Error ? error : new Error(String(error));
}

function readOptionalStringProp(obj: object, key: string): string | undefined {
  if (!(key in obj)) return undefined;
  const val: unknown = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function readOptionalPositiveInt(
  obj: object,
  keys: string[],
): number | "unknown" {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const raw: unknown = Object.getOwnPropertyDescriptor(obj, key)?.value;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return "unknown";
}

function buildQuotaDimension(
  used: number,
  limit: number | "unknown",
  unknownDetail: string,
): ProjectQuotaDimension {
  const isUnknown = limit === "unknown";
  return {
    status: isUnknown ? "unknown" : used >= limit ? "blocked" : "ok",
    limit,
    used,
    remaining: isUnknown ? "unknown" : Math.max(0, limit - used),
    source: isUnknown ? "inferred_from_sites" : "provider_reported",
    detail: isUnknown ? unknownDetail : undefined,
  };
}

function parseSitesArray(raw: unknown): SeRankingSite[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const parsed = seRankingSiteSchema.safeParse(item);
      return parsed.success ? parsed.data : null;
    })
    .filter((item): item is SeRankingSite => item !== null);
}

/**
 * Validates SE Ranking Project Management API auth, access, and reported
 * project/keyword/engine capacities without reading Data API `/account/subscription`.
 */
export async function validateProjectApiAccess(
  client: SeRankingClient,
  options?: { siteIdForEngineCheck?: number },
): Promise<ProjectApiAccessReport> {
  let accountEmail: string | undefined;
  let authSource: "users_me" | "sites_list" = "sites_list";
  let projectLimit: number | "unknown" = "unknown";
  let keywordLimit: number | "unknown" = "unknown";
  let usersMeForbidden = false;

  try {
    const meRaw = await client.request<unknown>(
      "/project-management/users/me",
      {
        method: "GET",
      },
    );
    if (meRaw && typeof meRaw === "object" && !Array.isArray(meRaw)) {
      authSource = "users_me";
      accountEmail = readOptionalStringProp(meRaw, "email");
      projectLimit = readOptionalPositiveInt(meRaw, [
        "sites_limit",
        "projects_limit",
        "max_sites",
        "max_projects",
      ]);
      keywordLimit = readOptionalPositiveInt(meRaw, [
        "keywords_limit",
        "keyword_limit",
        "max_keywords",
      ]);
    }
  } catch (error) {
    if (error instanceof SeRankingAuthError && error.upstreamStatus === 401) {
      throw classifyProjectApiError(error, "access");
    }
    if (error instanceof SeRankingAuthError && error.upstreamStatus === 403) {
      usersMeForbidden = true;
    } else if (
      error instanceof SeRankingCreditExhaustedError ||
      isTransientSeRankingError(error)
    ) {
      throw classifyProjectApiError(error, "access");
    }
    // 404 or unsupported /users/me falls back cleanly to /project-management/sites.
  }

  let sites: SeRankingSite[];
  try {
    const rawSites = await client.request<unknown>(
      "/project-management/sites",
      {
        method: "GET",
      },
    );
    sites = parseSitesArray(rawSites);
  } catch (error) {
    throw classifyProjectApiError(error, "access");
  }

  const usedProjects = sites.length;
  const usedKeywords = sites.reduce(
    (sum, site) => sum + (site.keywordCount ?? 0),
    0,
  );

  let engineStatus: "ok" | "unknown" | "blocked" = "unknown";
  let verifiedEngineCount: number | undefined;
  let engineDetail =
    "Device/location engine allocation limits are not exposed by SE Ranking site listings.";

  if (options?.siteIdForEngineCheck) {
    try {
      const enginesRaw = await client.request<unknown>(
        "/project-management/sites/search-engines",
        {
          method: "GET",
          params: { site_id: options.siteIdForEngineCheck },
        },
      );
      if (Array.isArray(enginesRaw)) {
        const parsed = enginesRaw
          .map((item) => seRankingSiteEngineSchema.safeParse(item))
          .filter((r) => r.success);
        verifiedEngineCount = parsed.length;
        engineStatus = "ok";
        engineDetail = `Verified ${parsed.length} configured site search engine(s) for remote site ${options.siteIdForEngineCheck}.`;
      }
    } catch (error) {
      const classified = classifyProjectApiError(error, "engine_create");
      if (
        classified instanceof AppError &&
        classified.code === "PAYMENT_REQUIRED"
      ) {
        engineStatus = "blocked";
        engineDetail = classified.message;
      }
    }
  }

  return {
    sites,
    apiAuth: {
      status: "ok",
      source: authSource,
      ...(accountEmail ? { accountEmail } : {}),
    },
    projectApi: {
      accessible: true,
      status: "ok",
      detail: usersMeForbidden
        ? "Verified /project-management/sites access (profile endpoint /users/me restricted)."
        : undefined,
    },
    projectSubscription: {
      status: "active",
      detail:
        "Project API endpoints are accessible. Data API /account/subscription credits are tracked separately.",
    },
    projectCapacity: buildQuotaDimension(
      usedProjects,
      projectLimit,
      "SE Ranking Project API does not return account-wide site limits on list-sites.",
    ),
    trackedKeywordCapacity: buildQuotaDimension(
      usedKeywords,
      keywordLimit,
      "SE Ranking Project API does not return account-wide keyword capacity on list-sites.",
    ),
    deviceLocationAllocations: {
      status: engineStatus,
      ...(verifiedEngineCount !== undefined ? { verifiedEngineCount } : {}),
      detail: engineDetail,
    },
    recheckRestrictions: {
      status: "unknown",
      detail:
        "SE Ranking evaluates recheck frequency and quota limits at POST /project-management/sites/positions/recheck.",
    },
  };
}

/**
 * Directly verifies whether an existing remote site remains accessible under the
 * active credentials before assuming an account change occurred.
 *
 * Returns:
 * - `true` when present in `listedSites` or confirmed accessible via `/sites/search-engines`
 * - `false` only on non-transient 401/403/404 confirmation
 * Throws a classified retryable error on 429, 5xx, timeouts, or network uncertainty.
 */
export async function verifySiteAccessible(
  client: SeRankingClient,
  siteId: number,
  listedSites: SeRankingSite[],
): Promise<boolean> {
  if (listedSites.some((site) => site.id === siteId)) {
    return true;
  }

  try {
    await client.request<unknown>("/project-management/sites/search-engines", {
      method: "GET",
      params: { site_id: siteId },
    });
    return true;
  } catch (error) {
    if (
      error instanceof SeRankingNotFoundError ||
      error instanceof SeRankingAuthError ||
      (error instanceof AppError &&
        (error.code === "NOT_FOUND" ||
          error.code === "FORBIDDEN" ||
          error.code === "UNAUTHENTICATED"))
    ) {
      return false;
    }
    throw classifyProjectApiError(error, "access");
  }
}
