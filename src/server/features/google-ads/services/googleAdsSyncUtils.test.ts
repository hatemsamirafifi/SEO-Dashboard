import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_SYNC_INITIAL_WINDOW_DAYS,
  GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES,
  GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS,
  GOOGLE_ADS_SYNC_RETRY_MAX_DELAY_MS,
  addGoogleAdsDays,
  clampGoogleAdsSyncWindow,
  eachGoogleAdsDay,
  googleAdsLastFullyCoveredDate,
  googleAdsSyncRetryDelay,
  googleAdsSyncToday,
  isGoogleAdsSyncStorageErrorClass,
  mapGoogleAdsSyncError,
  resolveGoogleAdsSyncWindow,
} from "./googleAdsSyncUtils";

function unit(
  date: string,
  grain: string,
  status = "success_with_data",
): {
  date: string;
  grain: string;
  status: string;
  publishedGenerationId: string | null;
} {
  return {
    date,
    grain,
    status,
    publishedGenerationId: status === "failed" ? null : "generation-1",
  };
}

describe("googleAdsSyncUtils calendar helpers", () => {
  it("adds and enumerates days across month boundaries in UTC", () => {
    expect(addGoogleAdsDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addGoogleAdsDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addGoogleAdsDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(eachGoogleAdsDay("2026-02-27", "2026-03-01")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(eachGoogleAdsDay("2026-02-28", "2026-02-28")).toEqual([
      "2026-02-28",
    ]);
  });

  it("derives the UTC today string", () => {
    expect(googleAdsSyncToday(new Date("2026-10-24T14:12:09.000Z"))).toBe(
      "2026-10-24",
    );
    expect(googleAdsSyncToday(new Date("2026-10-25T00:30:00.000Z"))).toBe(
      "2026-10-25",
    );
  });
});

describe("clampGoogleAdsSyncWindow", () => {
  it("rejects malformed calendar dates", () => {
    expect(clampGoogleAdsSyncWindow("2026-02-30", "2026-03-02")).toBeNull();
    expect(clampGoogleAdsSyncWindow("nope", "2026-03-02")).toBeNull();
    expect(clampGoogleAdsSyncWindow("2026-01-01", "2026/01/31")).toBeNull();
  });

  it("clamps a future end to today and orders start <= end", () => {
    const clamped = clampGoogleAdsSyncWindow(
      "2026-10-20",
      "2026-10-30",
      "2026-10-24",
    );
    expect(clamped).toEqual({ startDate: "2026-10-20", endDate: "2026-10-24" });
    expect(
      clampGoogleAdsSyncWindow("2026-10-30", "2026-10-20", "2026-10-24"),
    ).toEqual({ startDate: "2026-10-20", endDate: "2026-10-20" });
  });

  it("shrinks a too-wide window from the start, never past end", () => {
    const shrunk = clampGoogleAdsSyncWindow(
      "2020-01-01",
      "2026-10-24",
      "2026-10-24",
    );
    expect(shrunk).not.toBeNull();
    expect(shrunk?.startDate).toBe("2023-10-01");
    expect(shrunk?.endDate).toBe("2026-10-24");
    // An unordered window collapses to a single day instead of rejecting.
    expect(
      clampGoogleAdsSyncWindow("2020-01-30", "2020-01-02", "2026-10-24"),
    ).toEqual({ startDate: "2020-01-02", endDate: "2020-01-02" });
  });
});

describe("resolveGoogleAdsSyncWindow", () => {
  it("returns the bounded initial backfill without covered history", () => {
    const decision = resolveGoogleAdsSyncWindow(null, "2026-10-24");
    expect(decision.syncType).toBe("initial");
    expect(decision.endDate).toBe("2026-10-24");
    expect(decision.startDate).toBe("2026-09-27");
    expect(eachGoogleAdsDay(decision.startDate, decision.endDate)).toHaveLength(
      GOOGLE_ADS_SYNC_INITIAL_WINDOW_DAYS,
    );
  });

  it("increments from day after last covered date with a conversion-lag floor", () => {
    const decision = resolveGoogleAdsSyncWindow("2026-10-10", "2026-10-24");
    expect(decision.syncType).toBe("incremental");
    expect(decision.startDate).toBe("2026-10-11");
    expect(decision.endDate).toBe("2026-10-24");
  });

  it("slides the start to the 3-day lag floor when only recent history exists", () => {
    const decision = resolveGoogleAdsSyncWindow("2026-10-23", "2026-10-24");
    expect(decision).toMatchObject({
      syncType: "incremental",
      startDate: "2026-10-21",
      endDate: "2026-10-24",
    });
  });

  it("re-checks only the recent window when every day through today is covered", () => {
    const decision = resolveGoogleAdsSyncWindow("2026-10-24", "2026-10-24");
    expect(decision).toMatchObject({
      syncType: "refresh",
      startDate: "2026-10-21",
      endDate: "2026-10-24",
    });
  });
});

describe("googleAdsLastFullyCoveredDate", () => {
  it("requires every grain to be covered per date", () => {
    const units = [
      unit("2026-10-01", "account"),
      unit("2026-10-01", "campaign"),
      unit("2026-10-01", "ad_group"),
      unit("2026-10-01", "keyword"),
      unit("2026-10-01", "search_term"),
      unit("2026-10-01", "device"),
      unit("2026-10-01", "landing_page"),
      unit("2026-10-02", "account"),
      unit("2026-10-02", "campaign"),
      // One failed unit: 2026-10-02 is not fully covered.
      unit("2026-10-02", "ad_group", "failed"),
      unit("2026-10-02", "keyword"),
      unit("2026-10-02", "search_term"),
      unit("2026-10-02", "device"),
      unit("2026-10-02", "landing_page"),
    ];
    expect(googleAdsLastFullyCoveredDate(units)).toBe("2026-10-01");
  });

  it("returns null when no date covers all grains", () => {
    expect(googleAdsLastFullyCoveredDate([unit("2026-10-01", "account")])).toBe(
      null,
    );
    expect(googleAdsLastFullyCoveredDate([])).toBe(null);
  });
});

describe("mapGoogleAdsSyncError", () => {
  it("maps the fatal upstream classes", () => {
    expect(
      mapGoogleAdsSyncError({
        errorClass: "OAUTH_TOKEN_INVALID",
        retryable: false,
      }),
    ).toEqual({
      errorClass: "oauth_reconnect_required",
      fatal: true,
      retryable: false,
      runErrorClass: "AUTH",
    });
    expect(
      mapGoogleAdsSyncError({
        errorClass: "PERMISSION_DENIED",
        retryable: false,
      }).runErrorClass,
    ).toBe("PERMISSION");
    expect(
      mapGoogleAdsSyncError({
        errorClass: "QUOTA_EXHAUSTED",
        retryable: false,
      }).runErrorClass,
    ).toBe("QUOTA_EXHAUSTED");
  });

  it("keeps the documented transient classes retryable only when the classifier says so", () => {
    const boundedRetry = mapGoogleAdsSyncError(
      { errorClass: "QUOTA_TEMPORARILY_EXHAUSTED", retryable: false },
      { retryable: true },
    );
    expect(boundedRetry).toMatchObject({
      errorClass: "rate_limited",
      retryable: true,
      fatal: false,
      runErrorClass: "QUOTA_TRANSIENT",
    });
    expect(
      mapGoogleAdsSyncError({
        errorClass: "HTTP_ERROR_429",
        retryable: true,
      }),
    ).toMatchObject({
      errorClass: "transient_upstream",
      retryable: true,
    });
    expect(
      mapGoogleAdsSyncError({
        errorClass: "HTTP_ERROR_400",
        retryable: false,
      }).retryable,
    ).toBe(false);
  });

  it("falls back to the bounded unknown class otherwise", () => {
    expect(
      mapGoogleAdsSyncError({ errorClass: "SOMETHING_ELSE", retryable: false }),
    ).toEqual({
      errorClass: "unknown_error",
      fatal: false,
      retryable: false,
      runErrorClass: "INTERNAL",
    });
  });
});

describe("googleAdsSyncRetryDelay", () => {
  it("grows linearly from the base and is capped", () => {
    expect(googleAdsSyncRetryDelay(1)).toBe(
      GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS,
    );
    expect(googleAdsSyncRetryDelay(2)).toBe(1_000);
    expect(googleAdsSyncRetryDelay(GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES)).toBe(
      1_500,
    );
    expect(googleAdsSyncRetryDelay(50)).toBe(
      GOOGLE_ADS_SYNC_RETRY_MAX_DELAY_MS,
    );
  });
});

describe("isGoogleAdsSyncStorageErrorClass", () => {
  it("narrows exactly the bounded storage classes", () => {
    for (const value of [
      "oauth_reconnect_required",
      "api_access_denied",
      "quota_exhausted",
      "rate_limited",
      "transient_upstream",
      "validation_error",
      "malformed_response",
      "connection_fenced",
      "unknown_error",
    ]) {
      expect(isGoogleAdsSyncStorageErrorClass(value)).toBe(true);
    }
    expect(isGoogleAdsSyncStorageErrorClass("AUTH")).toBe(false);
    expect(isGoogleAdsSyncStorageErrorClass("")).toBe(false);
  });
});
