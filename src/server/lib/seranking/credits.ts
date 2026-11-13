import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { SeRankingCreditExhaustedError } from "./errors";
import type { SeRankingSubscription } from "./types";

export const DEFAULT_REQUEST_CREDIT_CAP = 2000;
export const DEFAULT_MONTHLY_CREDIT_CAP = 80000;

export type SeRankingOperation =
  | "account_subscription"
  | "keyword_metrics"
  | "keyword_ideas"
  | "domain_overview"
  | "domain_keywords"
  | "domain_pages"
  | "domain_competitors"
  | "backlinks_summary"
  | "backlinks_refdomains"
  | "backlinks_rows"
  | "backlinks_pages"
  | "backlinks_history";

export function estimateCreditCost(
  operation: SeRankingOperation,
  count = 1,
): number {
  switch (operation) {
    case "account_subscription":
      return 0; // Free
    case "keyword_metrics":
      // Bulk export: ~1 credit per keyword or min 10
      return Math.max(1, count);
    case "keyword_ideas":
      // 10 credits per returned keyword idea
      return Math.max(10, count * 10);
    case "domain_overview":
      return 100;
    case "domain_keywords":
    case "domain_pages":
    case "domain_competitors":
      return 100;
    case "backlinks_summary":
      return 100;
    case "backlinks_history":
      // 10 credits per target + 1 credit per returned date point
      return 10 + Math.max(1, count);
    case "backlinks_refdomains":
    case "backlinks_rows":
    case "backlinks_pages":
      return 100;
    default:
      return 100;
  }
}

export async function getRequestCreditCap(): Promise<number> {
  const envVal = await getOptionalEnvValue("SERANKING_REQUEST_CREDIT_CAP");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REQUEST_CREDIT_CAP;
}

export async function getMonthlyCreditCap(): Promise<number> {
  const envVal = await getOptionalEnvValue("SERANKING_MONTHLY_CREDIT_CAP");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MONTHLY_CREDIT_CAP;
}

export function assertBalanceSufficient(
  subscription: SeRankingSubscription,
  estimatedCost: number,
): void {
  if (subscription.status === "expired" || subscription.status === "disabled") {
    throw new SeRankingCreditExhaustedError(
      `SE Ranking subscription is ${subscription.status}. Please check your account.`,
    );
  }
  if (subscription.units_left < estimatedCost) {
    throw new SeRankingCreditExhaustedError(
      `SE Ranking balance insufficient: ${subscription.units_left} units remaining, but operation estimated to cost ${estimatedCost} units.`,
    );
  }
}

export interface SeRankingCreditReservation {
  reservationId: string;
  organizationId: string;
  estimatedUnits: number;
  commit(actualUnits?: number): Promise<void>;
  release(): Promise<void>;
}

type OrgPeriodSpend = {
  monthKey: string;
  spentUnits: number;
};

const orgSpendMap = new Map<string, OrgPeriodSpend>();

let cachedSubscriptionState: {
  data: SeRankingSubscription;
  fetchedAt: number;
} | null = null;

const SUBSCRIPTION_CACHE_TTL_MS = 60000;

export function resetCreditGuardState(): void {
  orgSpendMap.clear();
  cachedSubscriptionState = null;
}

export function getOrganizationSeRankingSpend(organizationId: string): number {
  const currentMonthKey = getMonthKey();
  const record = orgSpendMap.get(organizationId);
  if (!record || record.monthKey !== currentMonthKey) return 0;
  return record.spentUnits;
}

function getMonthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export type ReserveCreditsOptions = {
  organizationId: string;
  operation: SeRankingOperation;
  count?: number;
  customRequestCap?: number;
  customMonthlyCap?: number;
  client?: { getSubscription: () => Promise<SeRankingSubscription> };
};

export async function reserveSeRankingCredits(
  options: ReserveCreditsOptions,
): Promise<SeRankingCreditReservation> {
  const estimatedUnits = estimateCreditCost(
    options.operation,
    options.count ?? 1,
  );

  // 1. Check free operations
  if (estimatedUnits <= 0) {
    return {
      reservationId: "free",
      organizationId: options.organizationId,
      estimatedUnits: 0,
      commit: async () => {},
      release: async () => {},
    };
  }

  // 2. Check per-request cap
  const requestCap = options.customRequestCap ?? (await getRequestCreditCap());
  if (estimatedUnits > requestCap) {
    throw new SeRankingCreditExhaustedError(
      `SE Ranking operation '${options.operation}' estimated cost (${estimatedUnits} units) exceeds per-request cap (${requestCap} units)`,
    );
  }

  // 3. Check per-organization monthly budget
  const monthlyCap = options.customMonthlyCap ?? (await getMonthlyCreditCap());
  const currentMonthKey = getMonthKey();
  let orgRecord = orgSpendMap.get(options.organizationId);
  if (!orgRecord || orgRecord.monthKey !== currentMonthKey) {
    orgRecord = { monthKey: currentMonthKey, spentUnits: 0 };
    orgSpendMap.set(options.organizationId, orgRecord);
  }

  if (orgRecord.spentUnits + estimatedUnits > monthlyCap) {
    throw new SeRankingCreditExhaustedError(
      `SE Ranking monthly credit limit reached for organization ${options.organizationId} (${orgRecord.spentUnits}/${monthlyCap} units consumed)`,
    );
  }

  // 4. Check account balance if client is provided
  if (options.client) {
    let sub: SeRankingSubscription | null = null;
    const now = Date.now();

    if (
      cachedSubscriptionState &&
      now - cachedSubscriptionState.fetchedAt < SUBSCRIPTION_CACHE_TTL_MS
    ) {
      sub = cachedSubscriptionState.data;
      // If cached balance is lower than what we need, invalidate cache to check if topped up
      if (sub.units_left < estimatedUnits) {
        sub = null;
      }
    }

    if (!sub) {
      sub = await options.client.getSubscription();
      cachedSubscriptionState = { data: sub, fetchedAt: Date.now() };
    }

    assertBalanceSufficient(sub, estimatedUnits);
  }

  // Reserve units atomically
  orgRecord.spentUnits += estimatedUnits;
  let settled = false;

  return {
    reservationId: `res_${Math.random().toString(36).slice(2)}`,
    organizationId: options.organizationId,
    estimatedUnits,
    commit: async (actualUnits?: number) => {
      if (settled) return;
      settled = true;
      const settledUnits =
        actualUnits !== undefined ? Math.max(0, actualUnits) : estimatedUnits;
      if (actualUnits !== undefined && orgRecord) {
        const delta = settledUnits - estimatedUnits;
        orgRecord.spentUnits = Math.max(0, orgRecord.spentUnits + delta);
      }
      if (cachedSubscriptionState && settledUnits > 0) {
        cachedSubscriptionState.data = {
          ...cachedSubscriptionState.data,
          units_left: Math.max(
            0,
            cachedSubscriptionState.data.units_left - settledUnits,
          ),
        };
      }
    },
    release: async () => {
      if (settled) return;
      settled = true;
      if (orgRecord) {
        orgRecord.spentUnits = Math.max(
          0,
          orgRecord.spentUnits - estimatedUnits,
        );
      }
    },
  };
}
