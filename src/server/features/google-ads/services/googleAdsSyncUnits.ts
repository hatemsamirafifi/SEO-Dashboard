// The pending-unit pipeline for a live durable Google Ads sync run: every
// pending unit is fetched through the fixed daily reporting reads, staged
// and published atomically behind the live connection fence, and every
// outcome is recorded per unit (analytics ledger plus the unit run ledger).
// Committed successes are never re-fetched; a stale ledger save gives way
// to the newer attempt. Results and logs are always bounded — no upstream
// bodies, ids or credentials. Retry is reserved for the documented
// transient classes; auth, access, quota and fence loss halt the run
// immediately.

import {
  GoogleAdsAnalyticsFencedError,
  GoogleAdsAnalyticsRepository,
  type GoogleAdsAccountDimensionInput,
} from "../repositories/GoogleAdsAnalyticsRepository";
import {
  GoogleAdsSyncRepository,
  type GoogleAdsUnitPlan,
} from "../repositories/GoogleAdsSyncRepository";
import type {
  GoogleAdsPublishFence,
  GoogleAdsSyncErrorClass,
  GoogleAdsUnitScope,
} from "../repositories/googleAdsAnalyticsModel";
import type { GoogleAdsConnection } from "../repositories/GoogleAdsConnectionRepository";
import { fetchUnit, type GoogleAdsFetchOutcome } from "./googleAdsSyncFetch";
import type { GoogleAdsFactsClient } from "./googleAdsSyncFetch";
import {
  adGroupDimensionsFromRows,
  campaignDimensionsFromRows,
  keywordDimensionsFromRows,
  normalizedUnitRows,
} from "./googleAdsSyncNormalize";
import {
  GOOGLE_ADS_SYNC_LEASE_SECONDS,
  googleAdsSafeErrorText,
  type GoogleAdsSyncStorageErrorClass,
} from "./googleAdsSyncUtils";

export type GoogleAdsPendingUnitSummary = {
  succeeded: number;
  failed: number;
  firstFailure: {
    errorClass: GoogleAdsSyncStorageErrorClass;
    message: string;
  } | null;
  fatalCause: {
    runErrorClass: GoogleAdsSyncErrorClass;
    errorClass: GoogleAdsSyncStorageErrorClass;
    message: string;
  } | null;
};

export type GoogleAdsPendingUnitRun = {
  runId: string;
  attempt: number;
  pendingUnits: GoogleAdsUnitPlan[];
  client: GoogleAdsFactsClient;
  connection: GoogleAdsConnection;
  scope: GoogleAdsUnitScope;
  fence: GoogleAdsPublishFence;
  retryBaseDelayMs: number;
};

/** The analytics unit ledger stores RUN-model error classes; the sync's
 *  storage classes are distilled onto them where a fetch outcome carries
 *  its own run class, and otherwise fall back to the bounded plain ones. */
function analyticsUnitErrorClass(
  runErrorClass: GoogleAdsSyncErrorClass | null,
): GoogleAdsSyncErrorClass {
  return runErrorClass ?? "INTERNAL";
}

function accountDimensions(
  connection: GoogleAdsConnection,
): GoogleAdsAccountDimensionInput {
  return {
    descriptiveName: connection.customerDisplayName,
    currencyCode: connection.currencyCode,
    timeZone: connection.timeZone,
    isTestAccount: connection.isTestAccount,
  };
}

/** Records one unit failure in BOTH ledgers (analytics unit ledger plus the
 *  run ledger) and distills it into the run summary's first failure. */
async function failUnit(
  run: GoogleAdsPendingUnitRun,
  summary: GoogleAdsPendingUnitSummary,
  unit: GoogleAdsUnitPlan,
  failure: {
    status: "partial" | "failed";
    analyticsErrorClass: GoogleAdsSyncErrorClass;
    errorClass: GoogleAdsSyncStorageErrorClass;
    message: string;
  },
): Promise<void> {
  summary.failed += 1;
  summary.firstFailure ??= {
    errorClass: failure.errorClass,
    message: failure.message,
  };
  await GoogleAdsAnalyticsRepository.recordUnitFailure({
    scope: run.scope,
    date: unit.date,
    grain: unit.grain,
    status: failure.status,
    errorClass: failure.analyticsErrorClass,
    fence: run.fence,
  });
  await GoogleAdsSyncRepository.recordUnitResult(run.runId, run.attempt, unit, {
    status: failure.status,
    errorClass: failure.errorClass,
    errorMessage: failure.message,
  });
}

/** Dimension enrichment plus the atomic fact publish for one unit: every
 *  committed write carries the live connection fence, so a connection
 *  change between fetch and commit stays invisible. Dimensions come from
 *  the SAME fetched rows as the facts — a campaign never becomes invisible
 *  to the breakdown views while its fact rows are visible (or vice versa),
 *  and identity-less dimension rows are skipped without blocking facts. */
async function publishUnit(
  connection: GoogleAdsConnection,
  unit: GoogleAdsUnitPlan,
  request: {
    scope: GoogleAdsUnitScope;
    fence: GoogleAdsPublishFence;
    fetchOutcome: Extract<GoogleAdsFetchOutcome, { kind: "fetched" }>;
    stagedRows: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const { scope, fence, fetchOutcome, stagedRows } = request;
  switch (unit.grain) {
    case "account": {
      await GoogleAdsAnalyticsRepository.upsertAccountSnapshot(
        scope,
        accountDimensions(connection),
        { sourceFetchedAt: fetchOutcome.fetchedAt, fence },
      );
      break;
    }
    case "campaign": {
      await GoogleAdsAnalyticsRepository.upsertCampaigns(
        scope,
        campaignDimensionsFromRows(fetchOutcome.rows),
        { sourceFetchedAt: fetchOutcome.fetchedAt, fence },
      );
      break;
    }
    case "ad_group": {
      await GoogleAdsAnalyticsRepository.upsertAdGroups(
        scope,
        adGroupDimensionsFromRows(fetchOutcome.rows),
        { sourceFetchedAt: fetchOutcome.fetchedAt, fence },
      );
      break;
    }
    case "keyword": {
      await GoogleAdsAnalyticsRepository.upsertKeywords(
        scope,
        keywordDimensionsFromRows(fetchOutcome.rows),
        { sourceFetchedAt: fetchOutcome.fetchedAt, fence },
      );
      break;
    }
    // search_term, device and landing_page have no dimension tables: their
    // identity travels in the fact rows themselves.
    case "search_term":
    case "device":
    case "landing_page":
      break;
  }
  await GoogleAdsAnalyticsRepository.publishUnit({
    scope,
    date: unit.date,
    grain: unit.grain,
    rows: stagedRows,
    sourceFetchedAt: fetchOutcome.fetchedAt,
    currencyCode: connection.currencyCode,
    metricDateBasis: "interaction_date",
    fence,
  });
}

/** Runs the remaining pending units of a claimed run in fixed order,
 *  renewing the lease between units and honoring the claim window, and
 *  stops early only on a fatal class (auth, access, quota or fence loss);
 *  everything else is recorded per unit — a failed unit never fails the
 *  whole run. */
export async function runPendingUnits(
  run: GoogleAdsPendingUnitRun,
): Promise<GoogleAdsPendingUnitSummary> {
  const summary: GoogleAdsPendingUnitSummary = {
    succeeded: 0,
    failed: 0,
    firstFailure: null,
    fatalCause: null,
  };
  let lastLeaseRenewMs = Date.now();

  for (const unit of run.pendingUnits) {
    if (summary.fatalCause) {
      break;
    }
    // Time-based lease renewal between units keeps the claim alive for
    // windows that take longer than one lease.
    if (Date.now() - lastLeaseRenewMs > 1000) {
      lastLeaseRenewMs = Date.now();
      await GoogleAdsSyncRepository.renewLease(
        run.runId,
        run.attempt,
        GOOGLE_ADS_SYNC_LEASE_SECONDS,
      );
    }
    // Claim verification before every unit write: a stale attempt never
    // touches rows, it yields to the newer attempt instead.
    const isCurrent = await GoogleAdsSyncRepository.isRunClaimCurrent(
      run.runId,
      run.attempt,
    );
    if (!isCurrent) {
      summary.fatalCause = {
        runErrorClass: "FENCED",
        errorClass: "connection_fenced",
        message:
          "The sync run was resumed by another worker or the connection changed mid-run.",
      };
      break;
    }
    const fetchOutcome = await fetchUnit(run.client, unit.grain, unit, {
      customerId: run.connection.customerId,
      loginCustomerId: run.connection.loginCustomerId,
      retryBaseDelayMs: run.retryBaseDelayMs,
    });
    if (fetchOutcome.kind === "error") {
      // OAuth/access/quota halts: no further units are fetched; the run
      // records the bounded cause and abandons with its class.
      await failUnit(run, summary, unit, {
        status: "failed",
        analyticsErrorClass: analyticsUnitErrorClass(
          fetchOutcome.runErrorClass,
        ),
        errorClass: fetchOutcome.errorClass,
        message: fetchOutcome.message,
      });
      if (fetchOutcome.fatal) {
        summary.fatalCause = {
          runErrorClass: fetchOutcome.runErrorClass,
          errorClass: fetchOutcome.errorClass,
          message: fetchOutcome.message,
        };
        break;
      }
      continue;
    }

    // Truncated or malformed daily reads are NEVER published as complete
    // coverage: the unit is recorded partial (retryable by the next run)
    // and the run continues with the remaining units.
    if (fetchOutcome.truncated || fetchOutcome.malformedRows > 0) {
      await failUnit(run, summary, unit, {
        status: "partial",
        analyticsErrorClass: analyticsUnitErrorClass(null),
        errorClass: "malformed_response",
        message: "The Google Ads daily report was truncated or malformed.",
      });
      continue;
    }

    const normalized = normalizedUnitRows(
      unit.grain,
      unit.date,
      fetchOutcome.rows,
    );
    // A row that lost its grain keys in normalization never publishes as
    // complete coverage either: partial, retryable, and the run goes on.
    if (normalized.rows.length === 0 && fetchOutcome.rows.length > 0) {
      await failUnit(run, summary, unit, {
        status: "partial",
        analyticsErrorClass: analyticsUnitErrorClass(null),
        errorClass: "malformed_response",
        message: "No staged rows passed storage revalidation.",
      });
      continue;
    }

    try {
      await publishUnit(run.connection, unit, {
        scope: run.scope,
        fence: run.fence,
        fetchOutcome,
        stagedRows: normalized.rows,
      });
    } catch (err) {
      if (err instanceof GoogleAdsAnalyticsFencedError) {
        // The connection changed under us: stop before any more units are
        // written behind an invalid fence.
        summary.fatalCause = {
          runErrorClass: "FENCED",
          errorClass: "connection_fenced",
          message:
            "The Google Ads connection changed during the unit publish; the run was fenced.",
        };
        break;
      }
      const message = googleAdsSafeErrorText(
        err,
        "Google Ads unit publish failed.",
      );
      await failUnit(run, summary, unit, {
        status: "failed",
        analyticsErrorClass: analyticsUnitErrorClass("INTERNAL"),
        errorClass: "validation_error",
        message,
      });
      continue;
    }

    const saved = await GoogleAdsSyncRepository.recordUnitResult(
      run.runId,
      run.attempt,
      unit,
      {
        status:
          normalized.rows.length > 0
            ? "success_with_data"
            : "success_zero_rows",
      },
    );
    if (saved.outcome === "stale") {
      // The attempt lost its claim while this unit was in flight; the newer
      // attempt owns the unit bookkeeping from here.
      summary.fatalCause = {
        runErrorClass: "FENCED",
        errorClass: "connection_fenced",
        message:
          "The sync run was resumed by another worker or the connection changed mid-run.",
      };
      break;
    }
    summary.succeeded += 1;
  }

  // Generations whose units never published are redundant staging rows;
  // cleanup happens once at the end, never inside the per-unit fence.
  await GoogleAdsAnalyticsRepository.cleanupUnpublishedGenerations(run.scope);
  return summary;
}
