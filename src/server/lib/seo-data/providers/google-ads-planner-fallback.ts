import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnection,
} from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";
import { ProviderUnavailableError, RateLimitError } from "../errors";

const PROVIDER_NAME = "google_ads";

/** Bumped whenever the normalized planner payload shape changes so cache
 *  entries written by an older mapping self-heal to a miss. */
export const GOOGLE_ADS_PLANNER_CACHE_CONTRACT = "v26-planner";

export type PlannerBillingContext = {
  projectId?: string;
  organizationId: string;
};

export async function isPlannerResearchFallbackEnabled() {
  return (
    (await getOptionalEnvValue(
      "GOOGLE_ADS_KEYWORD_RESEARCH_FALLBACK_ENABLED",
    )) === "true"
  );
}

/** The fallback uses the project's explicit Ads mapping and the connector's
 * current grant. Run this before cache access and recheck on a live fill. */
export async function authorizePlannerResearchFallback(
  context: PlannerBillingContext,
) {
  if (!(await isPlannerResearchFallbackEnabled())) {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      "Automatic Keyword Planner fallback is disabled.",
    );
  }
  const connection = await getPlannerConnectionForBilling(context);
  if (!connection) {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      "Google Ads is not connected to this project.",
    );
  }
  const { GoogleAdsGrantRepository } =
    await import("@/server/features/google-ads/repositories/GoogleAdsGrantRepository");
  const grant = await GoogleAdsGrantRepository.getOwnedGrant(
    connection.connectedByUserId,
    connection.grantAccountId,
  );
  if (!grant || !GoogleAdsGrantRepository.hasAdsConsent(grant.scope)) {
    throw new AppError(
      "FORBIDDEN",
      "The connected Google Ads grant needs Ads consent.",
    );
  }
  // Include the connection revision so reconnecting cannot replay an older grant's results.
  return {
    connection,
    scope: JSON.stringify([
      connection.id,
      connection.updatedAt,
      connection.customerId,
      connection.loginCustomerId,
      connection.grantAccountId,
      connection.connectedByUserId,
      connection.currencyCode,
      GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
    ]),
  };
}

/** Connection lookup that can never throw: a billing context without a
 *  projectId and any repository failure resolve to "no planner identity".
 *  Callers distinguish only "connected" vs "not connected" â€” internal
 *  connection errors must not break the first-party walk, they surface the
 *  DataForSEO fallback. */
export async function getPlannerConnectionForBilling(
  context: PlannerBillingContext,
): Promise<GoogleAdsConnection | null> {
  try {
    if (!context.projectId) return null;
    return await GoogleAdsConnectionRepository.getByProjectId(
      context.projectId,
      context.organizationId,
    );
  } catch {
    return null;
  }
}

export async function reservePlannerResearchSlot(customerId: string) {
  const { env } = await import("cloudflare:workers");
  const limiter = env.GOOGLE_ADS_PLANNER_LIMITER;
  if (!limiter) {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      "Shared Keyword Planner cooldown is unavailable.",
    );
  }
  let response: Response;
  try {
    const id = limiter.idFromName(customerId);
    response = await limiter
      .get(id)
      .fetch("https://planner-limiter/reserve", { method: "POST" });
  } catch {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      "Shared Keyword Planner cooldown is unavailable.",
    );
  }
  if (response.status === 429) {
    throw new RateLimitError(
      PROVIDER_NAME,
      "Keyword Planner fallback quota is temporarily exhausted.",
    );
  }
  if (response.status !== 204) {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      "Shared Keyword Planner cooldown could not reserve a slot.",
    );
  }
}
