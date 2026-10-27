// One transient-aware fixed daily reporting fetch per unit.
//
// Retry is reserved for the documented transient error classes only; auth,
// access and quota failures stop immediately. Errors are always bounded —
// only the sanitized classifier output ever reaches the caller, never a
// response body, an id or a credential.

import {
  classifyGoogleAdsError,
  type createGoogleAdsClient,
} from "@/server/lib/googleAdsClient";
import type {
  GoogleAdsDailyAccountRow,
  GoogleAdsDailyAdGroupRow,
  GoogleAdsDailyCampaignRow,
  GoogleAdsDailyDeviceRow,
  GoogleAdsDailyFactsInput,
  GoogleAdsDailyKeywordRow,
  GoogleAdsDailyLandingPageRow,
  GoogleAdsDailySearchTermRow,
} from "@/server/lib/googleAdsReporting";
import {
  type GoogleAdsGrain,
  type GoogleAdsSyncErrorClass,
} from "../repositories/googleAdsAnalyticsModel";
import {
  GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES,
  googleAdsSafeErrorText,
  googleAdsSyncRetryDelay,
  mapGoogleAdsSyncError,
  type GoogleAdsSyncStorageErrorClass,
} from "./googleAdsSyncUtils";

export type GoogleAdsFactsClient = Pick<
  ReturnType<typeof createGoogleAdsClient>,
  | "getDailyAccountFacts"
  | "getDailyCampaignFacts"
  | "getDailyAdGroupFacts"
  | "getDailyKeywordFacts"
  | "getDailySearchTermFacts"
  | "getDailyDeviceFacts"
  | "getDailyLandingPageFacts"
>;

// The fetched rows are already schema-valid per grain by the transport
// (malformed rows are counted there, not thrown); this union is what flows
// into the storage side revalidation via normalizedUnitRows.
export type GoogleAdsDailyRow =
  | GoogleAdsDailyAccountRow
  | GoogleAdsDailyCampaignRow
  | GoogleAdsDailyAdGroupRow
  | GoogleAdsDailyKeywordRow
  | GoogleAdsDailySearchTermRow
  | GoogleAdsDailyDeviceRow
  | GoogleAdsDailyLandingPageRow;

export type GoogleAdsFetchedOutcome = {
  rows: GoogleAdsDailyRow[];
  truncated: boolean;
  malformedRows: number;
  fetchedAt: string;
};

export type GoogleAdsFetchOutcome =
  | ({ kind: "fetched" } & GoogleAdsFetchedOutcome)
  | {
      kind: "error";
      errorClass: GoogleAdsSyncStorageErrorClass;
      fatal: boolean;
      retryable: boolean;
      runErrorClass: GoogleAdsSyncErrorClass;
      message: string;
    };

/** One transient-aware fetch of a single unit. Retries ONLY the mapped
 *  retryable classes, bounded; the last failure class is handed back. */
export async function fetchUnit(
  client: GoogleAdsFactsClient,
  grain: GoogleAdsGrain,
  unit: { date: string },
  input: {
    customerId: string;
    loginCustomerId: string | null;
    retryBaseDelayMs: number;
  },
): Promise<GoogleAdsFetchOutcome> {
  const factsInput: GoogleAdsDailyFactsInput = {
    customerId: input.customerId,
    loginCustomerId: input.loginCustomerId,
    startDate: unit.date,
    endDate: unit.date,
  };
  let last: {
    errorClass: GoogleAdsSyncStorageErrorClass;
    fatal: boolean;
    retryable: boolean;
    runErrorClass: GoogleAdsSyncErrorClass;
    message: string;
  } | null = null;
  for (
    let attempt = 0;
    attempt <= GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES;
    attempt += 1
  ) {
    try {
      return {
        kind: "fetched",
        ...(await fetchDailyFacts(client, grain, factsInput)),
      };
    } catch (err) {
      const mapped = mapGoogleAdsSyncError(classifyGoogleAdsError(err));
      last = {
        ...mapped,
        message: googleAdsSafeErrorText(
          err,
          "Google Ads daily reporting read failed.",
        ),
      };
      if (!mapped.retryable) break;
      if (attempt === GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          googleAdsSyncRetryDelay(attempt + 1, input.retryBaseDelayMs),
        ),
      );
    }
  }
  return {
    kind: "error",
    errorClass: last?.errorClass ?? "unknown_error",
    fatal: last?.fatal ?? false,
    retryable: last?.retryable ?? false,
    runErrorClass: last?.runErrorClass ?? "INTERNAL",
    message: last?.message ?? "Google Ads daily reporting read failed.",
  };
}

/** Grain → fixed daily client method CALL, so adding a grain means editing
 *  exactly this table and the normalize tables — never protocol logic. The
 *  methods are called directly on the client receiver, keeping dispatch
 *  bound and the row typing per grain. */
async function fetchDailyFacts(
  client: GoogleAdsFactsClient,
  grain: GoogleAdsGrain,
  input: GoogleAdsDailyFactsInput,
): Promise<GoogleAdsFetchedOutcome> {
  switch (grain) {
    case "account": {
      const result = await client.getDailyAccountFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "campaign": {
      const result = await client.getDailyCampaignFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "ad_group": {
      const result = await client.getDailyAdGroupFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "keyword": {
      const result = await client.getDailyKeywordFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "search_term": {
      const result = await client.getDailySearchTermFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "device": {
      const result = await client.getDailyDeviceFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
    case "landing_page": {
      const result = await client.getDailyLandingPageFacts(input);
      return {
        rows: result.rows,
        truncated: result.truncated,
        malformedRows: result.malformedRows,
        fetchedAt: result.fetchedAt,
      };
    }
  }
}
