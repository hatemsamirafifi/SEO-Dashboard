/* eslint-disable max-lines -- grain-switched repository needs one shared
   publish/stored-query protocol */
import { and, asc, eq, gte, inArray, like, lte, ne, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { db } from "@/db";
import {
  googleAdsAccounts,
  googleAdsAdGroups,
  googleAdsAnalyticsUnits,
  googleAdsCampaigns,
  googleAdsConnections,
  googleAdsDailyAccount,
  googleAdsDailyAdGroup,
  googleAdsDailyCampaign,
  googleAdsDailyDevice,
  googleAdsDailyKeyword,
  googleAdsDailyLandingPage,
  googleAdsDailySearchTerm,
  googleAdsKeywords,
} from "@/db/schema";
import { executeInBatches, runBatch } from "@/db/runBatch";
import {
  GOOGLE_ADS_GRAINS,
  GOOGLE_ADS_METRIC_DATE_BASES,
  GOOGLE_ADS_SYNC_ERROR_CLASSES,
  googleAdsFactsWindowSchema,
  googleAdsPublishFenceSchema,
  googleAdsUnitScopeSchema,
  isGoogleAdsIsoDate,
  isGoogleAdsIsoInstant,
  parseStagedFactRows,
  type GoogleAdsFactsWindow,
  type GoogleAdsGrain,
  type GoogleAdsMetricDateBasis,
  type GoogleAdsMetricTotal,
  type GoogleAdsPublishFence,
  type GoogleAdsStagedFactRow,
  type GoogleAdsUnitScope,
} from "./googleAdsAnalyticsModel";

// Google Ads stored-analytics repository (master plan phase 3).
//
// Writes are scoped by (organization, project, customerId, date, grain).
// The publish protocol is a generation-pointer scheme, one complete
// daygrain "unit" at a time:
//   1. Optional fence check against the CURRENT google_ads_connections row.
//   2. Delete superseded generations of the unit.
//   3. Stage the new generation's rows chunk-by-chunk via executeInBatches.
//   4. One atomic runBatch "flip": delete generations that are not the new
//     one AND point the unit at the new generation. Readers join the units
//     pointer on the published generation id, so a failed chunk or a failed
//     flip never surfaces mixed or half-published data and the previous good
//     generation stays fully readable even when a newer reattempt fails.
//
// A COMPLETE empty unit flips to success_zero_rows (known zero). A failed or
// partial attempt NEVER publishes; recordUnitFailure only annotates the
// unit status so the service can flag incomplete coverage and retry.
//
// Grains are NEVER summed together here: each grain has its own aggregate
// query and row shape; per-dimension rows always carry their identifying
// resource ids so downstream evidence stays auditable.

export type GoogleAdsAccountSnapshot = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isTestAccount: boolean;
  sourceFetchedAt: string | null;
};

export type GoogleAdsUnitPointer = {
  date: string;
  grain: string;
  status: string;
  errorClass: string | null;
  publishedGenerationId: string | null;
  rowCount: number;
  sourceFetchedAt: string | null;
  currencyCode: string | null;
  metricDateBasis: string | null;
  publishedAt: string | null;
};

export type GoogleAdsSums = {
  rowCount: number;
  impressions: GoogleAdsMetricTotal;
  clicks: GoogleAdsMetricTotal;
  costMicros: GoogleAdsMetricTotal;
  conversions: GoogleAdsMetricTotal;
  conversionsValue: GoogleAdsMetricTotal;
};

export type GoogleAdsDailyTotals = {
  date: string;
  sums: GoogleAdsSums;
};

export type GoogleAdsCampaignTotals = {
  campaignResourceId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  campaignServingStatus: string | null;
  advertisingChannelType: string | null;
  sums: GoogleAdsSums;
};

export type GoogleAdsAdGroupTotals = {
  adGroupResourceId: string;
  campaignResourceId: string;
  adGroupName: string | null;
  adGroupStatus: string | null;
  sums: GoogleAdsSums;
};

export type GoogleAdsKeywordTotals = {
  keywordResourceId: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  keywordText: string | null;
  keywordMatchType: string | null;
  sums: GoogleAdsSums;
};

export type GoogleAdsSearchTermTotals = {
  campaignResourceId: string;
  adGroupResourceId: string;
  searchText: string;
  keywordText: string | null;
  keywordMatchType: string | null;
  sums: GoogleAdsSums;
};

export type GoogleAdsDeviceTotals = {
  device: string;
  sums: GoogleAdsSums;
};

export type GoogleAdsLandingPageTotals = {
  landingPageUrl: string;
  sums: GoogleAdsSums;
};

export type GoogleAdsLandingPageByResourceTotals = {
  campaignResourceId: string;
  sums: GoogleAdsSums;
};

export type GoogleAdsPublishUnitInput = {
  scope: GoogleAdsUnitScope;
  /** ISO date (YYYY-MM-DD) in the account time zone (segments.date). */
  date: string;
  grain: GoogleAdsGrain;
  /** Rows are revalidated at the storage boundary via parseStagedFactRows. */
  rows: readonly unknown[];
  /** ISO instant at which the source data was fetched. */
  sourceFetchedAt: string;
  /** Account currency observed with the data; null = explicitly unknown. */
  currencyCode: string | null;
  metricDateBasis: GoogleAdsMetricDateBasis | null;
  /** Optional fence validated against the current connection row. */
  fence?: GoogleAdsPublishFence | null;
};

export type GoogleAdsPublishUnitOutcome = {
  generationId: string;
  status: "success_with_data" | "success_zero_rows";
  rowCount: number;
};

export type GoogleAdsUnitFailureInput = {
  scope: GoogleAdsUnitScope;
  date: string;
  grain: GoogleAdsGrain;
  status: "partial" | "failed";
  /** Bounded server error class, never a verbatim provider payload. */
  errorClass: string;
  fence?: GoogleAdsPublishFence | null;
};

export class GoogleAdsAnalyticsFencedError extends Error {
  readonly reason: "disconnected" | "connection_changed";

  constructor(reason: "disconnected" | "connection_changed") {
    super(
      reason === "disconnected"
        ? "google ads connection no longer exists for this project"
        : "google ads connection changed to another customer or grant during the write",
    );
    this.name = "GoogleAdsAnalyticsFencedError";
    this.reason = reason;
  }
}

type FactTable =
  | typeof googleAdsDailyAccount
  | typeof googleAdsDailyCampaign
  | typeof googleAdsDailyAdGroup
  | typeof googleAdsDailyKeyword
  | typeof googleAdsDailySearchTerm
  | typeof googleAdsDailyDevice
  | typeof googleAdsDailyLandingPage;

// Same executor shape runBatch hands to its build callback (d1Db on D1,
// an identically-shaped tx handle on Postgres).
type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

type FactScopeShape = {
  projectId: Column;
  customerId: Column;
  date: Column;
  generationId: Column;
};

const FACT_TABLES: Record<GoogleAdsGrain, FactTable> = {
  account: googleAdsDailyAccount,
  campaign: googleAdsDailyCampaign,
  ad_group: googleAdsDailyAdGroup,
  keyword: googleAdsDailyKeyword,
  search_term: googleAdsDailySearchTerm,
  device: googleAdsDailyDevice,
  landing_page: googleAdsDailyLandingPage,
};

function supersededRowsWhere(
  table: FactScopeShape,
  scope: GoogleAdsUnitScope,
  date: string,
  keepGenerationId: string | null,
) {
  return and(
    eq(table.projectId, scope.projectId),
    eq(table.customerId, scope.customerId),
    eq(table.date, date),
    keepGenerationId === null
      ? undefined
      : ne(table.generationId, keepGenerationId),
  );
}

function publishedUnitJoin(grain: GoogleAdsGrain, fact: FactScopeShape) {
  return and(
    eq(googleAdsAnalyticsUnits.projectId, fact.projectId),
    eq(googleAdsAnalyticsUnits.customerId, fact.customerId),
    eq(googleAdsAnalyticsUnits.date, fact.date),
    eq(googleAdsAnalyticsUnits.grain, grain),
    eq(googleAdsAnalyticsUnits.publishedGenerationId, fact.generationId),
  );
}

function windowWhere(
  fact: FactScopeShape,
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
) {
  return and(
    eq(fact.projectId, scope.projectId),
    eq(fact.customerId, scope.customerId),
    gte(fact.date, window.startDate),
    lte(fact.date, window.endDate),
  );
}

function metricValues(metrics: GoogleAdsStagedFactRow["metrics"]) {
  return {
    impressions: metrics?.impressions ?? null,
    clicks: metrics?.clicks ?? null,
    costMicros: metrics?.costMicros ?? null,
    conversions: metrics?.conversions ?? null,
    conversionsValue: metrics?.conversionsValue ?? null,
  };
}

function requireDim(
  value: string | undefined,
  grain: GoogleAdsGrain,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Expected a non-empty ${field} for a ${grain} Google Ads fact row`,
    );
  }
  return value;
}

function baseValues(
  scope: GoogleAdsUnitScope,
  date: string,
  generationId: string,
) {
  return {
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    customerId: scope.customerId,
    date,
    generationId,
  };
}

// ---------------------------------------------------------------------------
// Connection fence
// ---------------------------------------------------------------------------

/** Fast-fail fence read OUTSIDE any write: callers get a typed fenced error
 *  for worker classification. The authoritative fence is re-checked inside
 *  the atomic flip below (see connectionFenceGate). */
async function assertPublishFence(
  scope: GoogleAdsUnitScope,
  fence: GoogleAdsPublishFence,
): Promise<void> {
  const rows = await db
    .select({
      id: googleAdsConnections.id,
      customerId: googleAdsConnections.customerId,
      grantAccountId: googleAdsConnections.grantAccountId,
      updatedAt: googleAdsConnections.updatedAt,
    })
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.projectId, scope.projectId),
        eq(googleAdsConnections.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) throw new GoogleAdsAnalyticsFencedError("disconnected");
  if (
    connection.customerId !== scope.customerId ||
    connection.id !== fence.connectionId ||
    connection.grantAccountId !== fence.grantAccountId ||
    connection.updatedAt !== fence.connectionUpdatedAt
  ) {
    throw new GoogleAdsAnalyticsFencedError("connection_changed");
  }
}

/** The write-time fence: inside the same atomic batch as the publish flip,
 *  a pointer update / superseded-row delete only applies when the CURRENT
 *  connection row still matches the fenced identity (including the
 *  immutable connection id). A deleted + re-created connection row, or an
 *  account switch-back, can never resurrect a stale generation. */
function connectionFenceGate(
  scope: GoogleAdsUnitScope,
  fence: GoogleAdsPublishFence,
) {
  return sql`EXISTS (SELECT 1 FROM ${googleAdsConnections} WHERE ${googleAdsConnections.projectId} = ${scope.projectId} AND ${googleAdsConnections.organizationId} = ${scope.organizationId} AND ${googleAdsConnections.customerId} = ${scope.customerId} AND ${googleAdsConnections.id} = ${fence.connectionId} AND ${googleAdsConnections.grantAccountId} = ${fence.grantAccountId} AND ${googleAdsConnections.updatedAt} = ${fence.connectionUpdatedAt})`;
}

/** Without an explicit fence, writes still require the (project, customer)
 *  connection row to exist: a disconnected project publishes nothing new. */
function connectionExistsGate(scope: GoogleAdsUnitScope) {
  return sql`EXISTS (SELECT 1 FROM ${googleAdsConnections} WHERE ${googleAdsConnections.projectId} = ${scope.projectId} AND ${googleAdsConnections.organizationId} = ${scope.organizationId} AND ${googleAdsConnections.customerId} = ${scope.customerId})`;
}

// ---------------------------------------------------------------------------
// Units pointer
// ---------------------------------------------------------------------------

function unitPointerFields() {
  return {
    date: googleAdsAnalyticsUnits.date,
    grain: googleAdsAnalyticsUnits.grain,
    status: googleAdsAnalyticsUnits.status,
    errorClass: googleAdsAnalyticsUnits.errorClass,
    publishedGenerationId: googleAdsAnalyticsUnits.publishedGenerationId,
    rowCount: googleAdsAnalyticsUnits.rowCount,
    sourceFetchedAt: googleAdsAnalyticsUnits.sourceFetchedAt,
    currencyCode: googleAdsAnalyticsUnits.currencyCode,
    metricDateBasis: googleAdsAnalyticsUnits.metricDateBasis,
    publishedAt: googleAdsAnalyticsUnits.publishedAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getPublishedGenerationId(
  scope: GoogleAdsUnitScope,
  date: string,
  grain: GoogleAdsGrain,
): Promise<string | null> {
  const rows = await db
    .select({
      publishedGenerationId: googleAdsAnalyticsUnits.publishedGenerationId,
    })
    .from(googleAdsAnalyticsUnits)
    .where(
      and(
        eq(googleAdsAnalyticsUnits.projectId, scope.projectId),
        eq(googleAdsAnalyticsUnits.customerId, scope.customerId),
        eq(googleAdsAnalyticsUnits.date, date),
        eq(googleAdsAnalyticsUnits.grain, grain),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row?.publishedGenerationId ?? null;
}

// ---------------------------------------------------------------------------
// Publish protocol
// ---------------------------------------------------------------------------

// Single grain-switched executor: splitting the builders would duplicate the
// conflict-target wiring on every branch.
// oxlint-disable-next-line max-params
function insertGrainBuilder(
  tx: BatchExecutor,
  grain: GoogleAdsGrain,
  scope: GoogleAdsUnitScope,
  date: string,
  generationId: string,
  row: GoogleAdsStagedFactRow,
) {
  const metrics = metricValues(row.metrics);
  const base = baseValues(scope, date, generationId);
  switch (grain) {
    case "account":
      return db
        .insert(googleAdsDailyAccount)
        .values({ ...base, ...metrics })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyAccount.projectId,
            googleAdsDailyAccount.customerId,
            googleAdsDailyAccount.date,
            googleAdsDailyAccount.generationId,
          ],
          set: metrics,
        });
    case "campaign": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      return db
        .insert(googleAdsDailyCampaign)
        .values({ ...base, ...metrics, campaignResourceId })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyCampaign.projectId,
            googleAdsDailyCampaign.customerId,
            googleAdsDailyCampaign.date,
            googleAdsDailyCampaign.campaignResourceId,
            googleAdsDailyCampaign.generationId,
          ],
          set: { ...metrics, campaignResourceId },
        });
    }
    case "ad_group": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      const adGroupResourceId = requireDim(
        row.adGroupResourceId,
        grain,
        "ad group resource id",
      );
      return db
        .insert(googleAdsDailyAdGroup)
        .values({ ...base, ...metrics, campaignResourceId, adGroupResourceId })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyAdGroup.projectId,
            googleAdsDailyAdGroup.customerId,
            googleAdsDailyAdGroup.date,
            googleAdsDailyAdGroup.adGroupResourceId,
            googleAdsDailyAdGroup.generationId,
          ],
          set: { ...metrics, campaignResourceId, adGroupResourceId },
        });
    }
    case "keyword": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      const adGroupResourceId = requireDim(
        row.adGroupResourceId,
        grain,
        "ad group resource id",
      );
      const keywordResourceId = requireDim(
        row.keywordResourceId,
        grain,
        "keyword resource id",
      );
      return db
        .insert(googleAdsDailyKeyword)
        .values({
          ...base,
          ...metrics,
          campaignResourceId,
          adGroupResourceId,
          keywordResourceId,
        })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyKeyword.projectId,
            googleAdsDailyKeyword.customerId,
            googleAdsDailyKeyword.date,
            googleAdsDailyKeyword.keywordResourceId,
            googleAdsDailyKeyword.generationId,
          ],
          set: {
            ...metrics,
            campaignResourceId,
            adGroupResourceId,
            keywordResourceId,
          },
        });
    }
    case "search_term": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      const adGroupResourceId = requireDim(
        row.adGroupResourceId,
        grain,
        "ad group resource id",
      );
      const searchText = requireDim(row.searchText, grain, "search text");
      return db
        .insert(googleAdsDailySearchTerm)
        .values({
          ...base,
          ...metrics,
          campaignResourceId,
          adGroupResourceId,
          searchText,
          keywordText: row.keywordText ?? null,
          keywordMatchType: row.keywordMatchType ?? null,
        })
        .onConflictDoUpdate({
          target: [
            googleAdsDailySearchTerm.projectId,
            googleAdsDailySearchTerm.customerId,
            googleAdsDailySearchTerm.date,
            googleAdsDailySearchTerm.campaignResourceId,
            googleAdsDailySearchTerm.adGroupResourceId,
            googleAdsDailySearchTerm.searchText,
            googleAdsDailySearchTerm.generationId,
          ],
          set: {
            ...metrics,
            campaignResourceId,
            adGroupResourceId,
            searchText,
            keywordText: row.keywordText ?? null,
            keywordMatchType: row.keywordMatchType ?? null,
          },
        });
    }
    case "device": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      const device = requireDim(row.device, grain, "device");
      return db
        .insert(googleAdsDailyDevice)
        .values({ ...base, ...metrics, campaignResourceId, device })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyDevice.projectId,
            googleAdsDailyDevice.customerId,
            googleAdsDailyDevice.date,
            googleAdsDailyDevice.campaignResourceId,
            googleAdsDailyDevice.device,
            googleAdsDailyDevice.generationId,
          ],
          set: { ...metrics, campaignResourceId, device },
        });
    }
    case "landing_page": {
      const campaignResourceId = requireDim(
        row.campaignResourceId,
        grain,
        "campaign resource id",
      );
      const landingPageUrl = requireDim(
        row.landingPageUrl,
        grain,
        "landing page url",
      );
      return db
        .insert(googleAdsDailyLandingPage)
        .values({ ...base, ...metrics, campaignResourceId, landingPageUrl })
        .onConflictDoUpdate({
          target: [
            googleAdsDailyLandingPage.projectId,
            googleAdsDailyLandingPage.customerId,
            googleAdsDailyLandingPage.date,
            googleAdsDailyLandingPage.campaignResourceId,
            googleAdsDailyLandingPage.landingPageUrl,
            googleAdsDailyLandingPage.generationId,
          ],
          set: { ...metrics, campaignResourceId, landingPageUrl },
        });
    }
  }
}

async function deleteSupersededGenerations(
  scope: GoogleAdsUnitScope,
  date: string,
  grain: GoogleAdsGrain,
  keepGenerationId: string | null,
): Promise<void> {
  const table = FACT_TABLES[grain];
  await runBatch((tx) => [
    tx
      .delete(table)
      .where(supersededRowsWhere(table, scope, date, keepGenerationId)),
  ]);
}

/** Publishes one complete date+grain unit atomically; see the module header.
 *  Fence order:
 *  1. Fast-fail read (typed fenced errors for the worker).
 *  2. A pointer "promise" row is created only when absent, carrying
 *     publishedGenerationId = null: readers can see NOTHING new this way even
 *     if the connection dies during staging.
 *  3. The flip itself is gated INSIDE the atomic batch by the current
 *     google_ads_connections row (id + grant + updatedAt + customer): a
 *     deleted + re-created connection, or an account switch-back, can never
 *     resurrect a stale generation, and gate rejection also leaves the
 *     previous generation untouched and readable.
 *  4. A read-back verifies the flip landed; otherwise it surfaces as a typed
 *     fenced error. */
async function publishUnit(
  input: GoogleAdsPublishUnitInput,
): Promise<GoogleAdsPublishUnitOutcome> {
  const scope = googleAdsUnitScopeSchema.parse(input.scope);
  if (!isGoogleAdsIsoDate(input.date)) {
    throw new Error("Expected an ISO YYYY-MM-DD Google Ads reporting date");
  }
  if (!isGoogleAdsIsoInstant(input.sourceFetchedAt)) {
    throw new Error("Expected an ISO instant for sourceFetchedAt");
  }
  if (
    input.metricDateBasis !== null &&
    !GOOGLE_ADS_METRIC_DATE_BASES.includes(input.metricDateBasis)
  ) {
    throw new Error("Expected a known Google Ads metric date basis");
  }
  const fence = input.fence
    ? googleAdsPublishFenceSchema.parse(input.fence)
    : null;
  const rows = parseStagedFactRows(input.grain, input.rows);
  if (fence) await assertPublishFence(scope, fence);
  const gate = fence
    ? connectionFenceGate(scope, fence)
    : connectionExistsGate(scope);

  const generationId = crypto.randomUUID();
  const keepGenerationId = await getPublishedGenerationId(
    scope,
    input.date,
    input.grain,
  );

  // Pointer promise: only inserts when the unit pointer is absent. It never
  // clobbers an already published unit and, with a null published generation,
  // remains invisible to readers if publishing is interrupted.
  await runBatch((tx) => [
    tx
      .insert(googleAdsAnalyticsUnits)
      .values({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        date: input.date,
        grain: input.grain,
        publishedGenerationId: null,
        status: "pending" as const,
        rowCount: 0,
      })
      .onConflictDoNothing({
        target: [
          googleAdsAnalyticsUnits.projectId,
          googleAdsAnalyticsUnits.customerId,
          googleAdsAnalyticsUnits.date,
          googleAdsAnalyticsUnits.grain,
        ],
      }),
  ]);

  // Clean stale staging rows from interrupted attempts (never the currently
  // published generation).
  await deleteSupersededGenerations(
    scope,
    input.date,
    input.grain,
    keepGenerationId,
  );
  await executeInBatches(rows, (tx, row) =>
    insertGrainBuilder(tx, input.grain, scope, input.date, generationId, row),
  );

  const status = rows.length
    ? ("success_with_data" as const)
    : ("success_zero_rows" as const);
  const table = FACT_TABLES[input.grain];
  const flipSet = {
    publishedGenerationId: generationId,
    status,
    rowCount: rows.length,
    sourceFetchedAt: input.sourceFetchedAt,
    currencyCode: input.currencyCode,
    metricDateBasis: input.metricDateBasis,
    stagedAt: null,
    publishedAt: nowIso(),
    errorClass: null,
    updatedAt: nowIso(),
  };
  await runBatch((tx) => [
    tx
      .delete(table)
      .where(
        and(supersededRowsWhere(table, scope, input.date, generationId), gate),
      ),
    tx
      .update(googleAdsAnalyticsUnits)
      .set(flipSet)
      .where(
        and(
          eq(googleAdsAnalyticsUnits.projectId, scope.projectId),
          eq(googleAdsAnalyticsUnits.organizationId, scope.organizationId),
          eq(googleAdsAnalyticsUnits.customerId, scope.customerId),
          eq(googleAdsAnalyticsUnits.date, input.date),
          eq(googleAdsAnalyticsUnits.grain, input.grain),
          gate,
        ),
      ),
  ]);
  if (
    (await getPublishedGenerationId(scope, input.date, input.grain)) !==
    generationId
  ) {
    // The gate rejected the flip (connection deleted/re-created, switched
    // away, disconnected, or the pointer vanished mid-flight). Race during
    // staging: staged rows will be cleaned up by a later legitimate attempt's
    // deleteSupersededGenerations; old data remains readable.
    throw new GoogleAdsAnalyticsFencedError("connection_changed");
  }
  return { generationId, status, rowCount: rows.length };
}

/** Marks a unit failed or partial WITHOUT changing its published generation:
 *  the last good published rows stay readable, coverage reports the latest
 *  failure. The unit stays retryable. */
async function recordUnitFailure(
  input: GoogleAdsUnitFailureInput,
): Promise<void> {
  const scope = googleAdsUnitScopeSchema.parse(input.scope);
  if (!isGoogleAdsIsoDate(input.date)) {
    throw new Error("Expected an ISO YYYY-MM-DD Google Ads reporting date");
  }
  if (
    !(GOOGLE_ADS_SYNC_ERROR_CLASSES as readonly string[]).includes(
      input.errorClass,
    )
  ) {
    throw new Error("Expected a bounded Google Ads sync error class");
  }
  if (input.fence) {
    await assertPublishFence(scope, input.fence);
  }
  await runBatch((tx) => [
    tx
      .insert(googleAdsAnalyticsUnits)
      .values({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        date: input.date,
        grain: input.grain,
        publishedGenerationId: null,
        status: input.status,
        errorClass: input.errorClass,
      })
      .onConflictDoUpdate({
        target: [
          googleAdsAnalyticsUnits.projectId,
          googleAdsAnalyticsUnits.customerId,
          googleAdsAnalyticsUnits.date,
          googleAdsAnalyticsUnits.grain,
        ],
        set: {
          status: input.status,
          errorClass: input.errorClass,
          updatedAt: nowIso(),
        },
        setWhere: and(
          eq(googleAdsAnalyticsUnits.organizationId, scope.organizationId),
          // Only regress coverage on a connection that still exists today;
          // a disconnected project keeps its last reported state.
          connectionExistsGate(scope),
        ),
      }),
  ]);
}

// ---------------------------------------------------------------------------
// Dimension upserts
// ---------------------------------------------------------------------------

export type GoogleAdsAccountDimensionInput = {
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isTestAccount: boolean;
};

export type GoogleAdsCampaignDimensionInput = {
  campaignResourceId: string;
  campaignId: string;
  name: string;
  status: string;
  servingStatus: string | null;
  advertisingChannelType: string | null;
};

export type GoogleAdsAdGroupDimensionInput = {
  adGroupResourceId: string;
  campaignResourceId: string;
  name: string;
  status: string;
};

export type GoogleAdsKeywordDimensionInput = {
  keywordResourceId: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  keywordText: string;
  keywordMatchType: string | null;
};

function assertReferenceText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Expected a non-empty ${field}`);
  }
  return value;
}

async function upsertAccountSnapshot(
  scope: GoogleAdsUnitScope,
  account: GoogleAdsAccountDimensionInput,
  options: { sourceFetchedAt: string; fence?: GoogleAdsPublishFence | null },
): Promise<void> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  if (!isGoogleAdsIsoInstant(options.sourceFetchedAt)) {
    throw new Error("Expected an ISO instant for sourceFetchedAt");
  }
  if (options.fence) await assertPublishFence(s, options.fence);
  await db
    .insert(googleAdsAccounts)
    .values({
      id: crypto.randomUUID(),
      projectId: s.projectId,
      organizationId: s.organizationId,
      customerId: s.customerId,
      descriptiveName: account.descriptiveName,
      currencyCode: account.currencyCode,
      timeZone: account.timeZone,
      isTestAccount: account.isTestAccount,
      sourceFetchedAt: options.sourceFetchedAt,
    })
    .onConflictDoUpdate({
      target: [googleAdsAccounts.projectId, googleAdsAccounts.customerId],
      set: {
        descriptiveName: account.descriptiveName,
        currencyCode: account.currencyCode,
        timeZone: account.timeZone,
        isTestAccount: account.isTestAccount,
        sourceFetchedAt: options.sourceFetchedAt,
        updatedAt: nowIso(),
      },
      setWhere: eq(googleAdsAccounts.organizationId, s.organizationId),
    });
}

async function upsertCampaigns(
  scope: GoogleAdsUnitScope,
  campaigns: readonly GoogleAdsCampaignDimensionInput[],
  options: { sourceFetchedAt: string; fence?: GoogleAdsPublishFence | null },
): Promise<void> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  if (!isGoogleAdsIsoInstant(options.sourceFetchedAt)) {
    throw new Error("Expected an ISO instant for sourceFetchedAt");
  }
  if (options.fence) await assertPublishFence(s, options.fence);
  const values = campaigns.map((campaign) => ({
    id: crypto.randomUUID(),
    projectId: s.projectId,
    organizationId: s.organizationId,
    customerId: s.customerId,
    campaignResourceId: assertReferenceText(
      campaign.campaignResourceId,
      "campaign resource id",
    ),
    campaignId: assertReferenceText(campaign.campaignId, "campaign id"),
    name: assertReferenceText(campaign.name, "campaign name"),
    status: assertReferenceText(campaign.status, "campaign status"),
    servingStatus: campaign.servingStatus,
    advertisingChannelType: campaign.advertisingChannelType,
    sourceFetchedAt: options.sourceFetchedAt,
  }));
  if (values.length === 0) return;
  await executeInBatches(values, (tx, value) =>
    tx
      .insert(googleAdsCampaigns)
      .values(value)
      .onConflictDoUpdate({
        target: [
          googleAdsCampaigns.projectId,
          googleAdsCampaigns.customerId,
          googleAdsCampaigns.campaignResourceId,
        ],
        set: {
          campaignId: value.campaignId,
          name: value.name,
          status: value.status,
          servingStatus: value.servingStatus,
          advertisingChannelType: value.advertisingChannelType,
          sourceFetchedAt: value.sourceFetchedAt,
          updatedAt: nowIso(),
        },
        setWhere: eq(googleAdsCampaigns.organizationId, s.organizationId),
      }),
  );
}

async function upsertAdGroups(
  scope: GoogleAdsUnitScope,
  adGroups: readonly GoogleAdsAdGroupDimensionInput[],
  options: { sourceFetchedAt: string; fence?: GoogleAdsPublishFence | null },
): Promise<void> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  if (!isGoogleAdsIsoInstant(options.sourceFetchedAt)) {
    throw new Error("Expected an ISO instant for sourceFetchedAt");
  }
  if (options.fence) await assertPublishFence(s, options.fence);
  const values = adGroups.map((adGroup) => ({
    id: crypto.randomUUID(),
    projectId: s.projectId,
    organizationId: s.organizationId,
    customerId: s.customerId,
    adGroupResourceId: assertReferenceText(
      adGroup.adGroupResourceId,
      "ad group resource id",
    ),
    campaignResourceId: assertReferenceText(
      adGroup.campaignResourceId,
      "campaign resource id",
    ),
    name: assertReferenceText(adGroup.name, "ad group name"),
    status: assertReferenceText(adGroup.status, "ad group status"),
    sourceFetchedAt: options.sourceFetchedAt,
  }));
  if (values.length === 0) return;
  await executeInBatches(values, (tx, value) =>
    tx
      .insert(googleAdsAdGroups)
      .values(value)
      .onConflictDoUpdate({
        target: [
          googleAdsAdGroups.projectId,
          googleAdsAdGroups.customerId,
          googleAdsAdGroups.adGroupResourceId,
        ],
        set: {
          campaignResourceId: value.campaignResourceId,
          name: value.name,
          status: value.status,
          sourceFetchedAt: value.sourceFetchedAt,
          updatedAt: nowIso(),
        },
        setWhere: eq(googleAdsAdGroups.organizationId, s.organizationId),
      }),
  );
}

async function upsertKeywords(
  scope: GoogleAdsUnitScope,
  keywords: readonly GoogleAdsKeywordDimensionInput[],
  options: { sourceFetchedAt: string; fence?: GoogleAdsPublishFence | null },
): Promise<void> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  if (!isGoogleAdsIsoInstant(options.sourceFetchedAt)) {
    throw new Error("Expected an ISO instant for sourceFetchedAt");
  }
  if (options.fence) await assertPublishFence(s, options.fence);
  const values = keywords.map((keyword) => ({
    id: crypto.randomUUID(),
    projectId: s.projectId,
    organizationId: s.organizationId,
    customerId: s.customerId,
    keywordResourceId: assertReferenceText(
      keyword.keywordResourceId,
      "keyword resource id",
    ),
    campaignResourceId: assertReferenceText(
      keyword.campaignResourceId,
      "campaign resource id",
    ),
    adGroupResourceId: assertReferenceText(
      keyword.adGroupResourceId,
      "ad group resource id",
    ),
    keywordText: assertReferenceText(keyword.keywordText, "keyword text"),
    keywordMatchType: keyword.keywordMatchType,
    sourceFetchedAt: options.sourceFetchedAt,
  }));
  if (values.length === 0) return;
  await executeInBatches(values, (tx, value) =>
    tx
      .insert(googleAdsKeywords)
      .values(value)
      .onConflictDoUpdate({
        target: [
          googleAdsKeywords.projectId,
          googleAdsKeywords.customerId,
          googleAdsKeywords.keywordResourceId,
        ],
        set: {
          campaignResourceId: value.campaignResourceId,
          adGroupResourceId: value.adGroupResourceId,
          keywordText: value.keywordText,
          keywordMatchType: value.keywordMatchType,
          sourceFetchedAt: value.sourceFetchedAt,
          updatedAt: nowIso(),
        },
        setWhere: eq(googleAdsKeywords.organizationId, s.organizationId),
      }),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function factAggregateFields(table: FactTable) {
  return {
    rowCount: sql<number>`count(*)`,
    impressions: sql<number | null>`sum(${table.impressions})`,
    impressionsHasMissing: sql<
      number | null
    >`max(case when ${table.impressions} is null then 1 else 0 end)`,
    clicks: sql<number | null>`sum(${table.clicks})`,
    clicksHasMissing: sql<
      number | null
    >`max(case when ${table.clicks} is null then 1 else 0 end)`,
    costMicros: sql<number | null>`sum(${table.costMicros})`,
    costMicrosHasMissing: sql<
      number | null
    >`max(case when ${table.costMicros} is null then 1 else 0 end)`,
    conversions: sql<number | null>`sum(${table.conversions})`,
    conversionsHasMissing: sql<
      number | null
    >`max(case when ${table.conversions} is null then 1 else 0 end)`,
    conversionsValue: sql<number | null>`sum(${table.conversionsValue})`,
    conversionsValueHasMissing: sql<
      number | null
    >`max(case when ${table.conversionsValue} is null then 1 else 0 end)`,
  };
}

type AggregateRow = {
  rowCount: number;
  impressions: number | null;
  impressionsHasMissing: number | null;
  clicks: number | null;
  clicksHasMissing: number | null;
  costMicros: number | null;
  costMicrosHasMissing: number | null;
  conversions: number | null;
  conversionsHasMissing: number | null;
  conversionsValue: number | null;
  conversionsValueHasMissing: number | null;
};

function metricTotal(
  total: number | null,
  hasMissing: number | null,
): GoogleAdsMetricTotal {
  return { total, hasMissingComponents: hasMissing === 1 };
}

function toSums(row: AggregateRow): GoogleAdsSums {
  return {
    rowCount: row.rowCount,
    impressions: metricTotal(row.impressions, row.impressionsHasMissing),
    clicks: metricTotal(row.clicks, row.clicksHasMissing),
    costMicros: metricTotal(row.costMicros, row.costMicrosHasMissing),
    conversions: metricTotal(row.conversions, row.conversionsHasMissing),
    conversionsValue: metricTotal(
      row.conversionsValue,
      row.conversionsValueHasMissing,
    ),
  };
}

function zeroSums(): GoogleAdsSums {
  const metric: GoogleAdsMetricTotal = {
    total: null,
    hasMissingComponents: false,
  };
  return {
    rowCount: 0,
    impressions: { ...metric },
    clicks: { ...metric },
    costMicros: { ...metric },
    conversions: { ...metric },
    conversionsValue: { ...metric },
  };
}

export type GoogleAdsReadOptions = {
  /** Exact search-term text filter (totals for exactly one term). */
  searchText?: string;
  /** Case-insensitive LIKE %…% filter for search-term text. */
  searchTextLike?: string;
  /** Restrict device / landing-page grains to one campaign. */
  campaignResourceId?: string;
};

export function selectUnitsSafe(
  scope: GoogleAdsUnitScope,
  options: {
    grains?: readonly GoogleAdsGrain[];
    startDate?: string;
    endDate?: string;
  },
): Promise<GoogleAdsUnitPointer[]> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  const filters = [
    eq(googleAdsAnalyticsUnits.projectId, s.projectId),
    eq(googleAdsAnalyticsUnits.customerId, s.customerId),
    eq(googleAdsAnalyticsUnits.organizationId, s.organizationId),
  ];
  if (options.startDate !== undefined) {
    filters.push(gte(googleAdsAnalyticsUnits.date, options.startDate));
  }
  if (options.endDate !== undefined) {
    filters.push(lte(googleAdsAnalyticsUnits.date, options.endDate));
  }
  if (options.grains !== undefined && options.grains.length > 0) {
    filters.push(inArray(googleAdsAnalyticsUnits.grain, [...options.grains]));
  }
  return db
    .select(unitPointerFields())
    .from(googleAdsAnalyticsUnits)
    .where(and(...filters))
    .orderBy(
      asc(googleAdsAnalyticsUnits.grain),
      asc(googleAdsAnalyticsUnits.date),
    );
}

export async function getUnit(
  scope: GoogleAdsUnitScope,
  date: string,
  grain: GoogleAdsGrain,
): Promise<GoogleAdsUnitPointer | null> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  if (!isGoogleAdsIsoDate(date)) {
    throw new Error("Expected an ISO YYYY-MM-DD Google Ads reporting date");
  }
  const rows = await db
    .select(unitPointerFields())
    .from(googleAdsAnalyticsUnits)
    .where(
      and(
        eq(googleAdsAnalyticsUnits.projectId, s.projectId),
        eq(googleAdsAnalyticsUnits.customerId, s.customerId),
        eq(googleAdsAnalyticsUnits.date, date),
        eq(googleAdsAnalyticsUnits.grain, grain),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getAccountSnapshot(
  scope: GoogleAdsUnitScope,
): Promise<GoogleAdsAccountSnapshot | null> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  const rows = await db
    .select({
      customerId: googleAdsAccounts.customerId,
      descriptiveName: googleAdsAccounts.descriptiveName,
      currencyCode: googleAdsAccounts.currencyCode,
      timeZone: googleAdsAccounts.timeZone,
      isTestAccount: googleAdsAccounts.isTestAccount,
      sourceFetchedAt: googleAdsAccounts.sourceFetchedAt,
    })
    .from(googleAdsAccounts)
    .where(
      and(
        eq(googleAdsAccounts.projectId, s.projectId),
        eq(googleAdsAccounts.customerId, s.customerId),
        eq(googleAdsAccounts.organizationId, s.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function sumAccountWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
): Promise<GoogleAdsSums> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select(factAggregateFields(googleAdsDailyAccount))
    .from(googleAdsDailyAccount)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("account", googleAdsDailyAccount),
    )
    .where(windowWhere(googleAdsDailyAccount, scope, w))
    .limit(1);
  return rows[0] ? toSums(rows[0]) : zeroSums();
}

export async function sumAccountByDate(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
): Promise<GoogleAdsDailyTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      date: googleAdsDailyAccount.date,
      ...factAggregateFields(googleAdsDailyAccount),
    })
    .from(googleAdsDailyAccount)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("account", googleAdsDailyAccount),
    )
    .where(windowWhere(googleAdsDailyAccount, scope, w))
    .groupBy(googleAdsDailyAccount.date)
    .orderBy(asc(googleAdsDailyAccount.date));
  return rows.map((row) => ({
    date: row.date,
    sums: toSums(row),
  }));
}

export async function sumCampaignWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
): Promise<GoogleAdsCampaignTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      campaignResourceId: googleAdsDailyCampaign.campaignResourceId,
      campaignName: sql<string | null>`max(${googleAdsCampaigns.name})`,
      campaignStatus: sql<string | null>`max(${googleAdsCampaigns.status})`,
      campaignServingStatus: sql<
        string | null
      >`max(${googleAdsCampaigns.servingStatus})`,
      advertisingChannelType: sql<
        string | null
      >`max(${googleAdsCampaigns.advertisingChannelType})`,
      ...factAggregateFields(googleAdsDailyCampaign),
    })
    .from(googleAdsDailyCampaign)
    .leftJoin(
      googleAdsCampaigns,
      and(
        eq(googleAdsCampaigns.projectId, googleAdsDailyCampaign.projectId),
        eq(googleAdsCampaigns.customerId, googleAdsDailyCampaign.customerId),
        eq(
          googleAdsCampaigns.campaignResourceId,
          googleAdsDailyCampaign.campaignResourceId,
        ),
      ),
    )
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("campaign", googleAdsDailyCampaign),
    )
    .where(windowWhere(googleAdsDailyCampaign, scope, w))
    .groupBy(googleAdsDailyCampaign.campaignResourceId)
    .orderBy(asc(googleAdsDailyCampaign.campaignResourceId));
  return rows.map((row) => ({
    campaignResourceId: row.campaignResourceId,
    campaignName: row.campaignName,
    campaignStatus: row.campaignStatus,
    campaignServingStatus: row.campaignServingStatus,
    advertisingChannelType: row.advertisingChannelType,
    sums: toSums(row),
  }));
}

export async function sumAdGroupWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
): Promise<GoogleAdsAdGroupTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      adGroupResourceId: googleAdsDailyAdGroup.adGroupResourceId,
      campaignResourceId: googleAdsDailyAdGroup.campaignResourceId,
      adGroupName: sql<string | null>`max(${googleAdsAdGroups.name})`,
      adGroupStatus: sql<string | null>`max(${googleAdsAdGroups.status})`,
      ...factAggregateFields(googleAdsDailyAdGroup),
    })
    .from(googleAdsDailyAdGroup)
    .leftJoin(
      googleAdsAdGroups,
      and(
        eq(googleAdsAdGroups.projectId, googleAdsDailyAdGroup.projectId),
        eq(googleAdsAdGroups.customerId, googleAdsDailyAdGroup.customerId),
        eq(
          googleAdsAdGroups.adGroupResourceId,
          googleAdsDailyAdGroup.adGroupResourceId,
        ),
      ),
    )
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("ad_group", googleAdsDailyAdGroup),
    )
    .where(windowWhere(googleAdsDailyAdGroup, scope, w))
    .groupBy(
      googleAdsDailyAdGroup.adGroupResourceId,
      googleAdsDailyAdGroup.campaignResourceId,
    )
    .orderBy(asc(googleAdsDailyAdGroup.adGroupResourceId));
  return rows.map((row) => ({
    adGroupResourceId: row.adGroupResourceId,
    campaignResourceId: row.campaignResourceId,
    adGroupName: row.adGroupName,
    adGroupStatus: row.adGroupStatus,
    sums: toSums(row),
  }));
}

export async function sumKeywordWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
): Promise<GoogleAdsKeywordTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      keywordResourceId: googleAdsDailyKeyword.keywordResourceId,
      campaignResourceId: googleAdsDailyKeyword.campaignResourceId,
      adGroupResourceId: googleAdsDailyKeyword.adGroupResourceId,
      keywordText: sql<string | null>`max(${googleAdsKeywords.keywordText})`,
      keywordMatchType: sql<
        string | null
      >`max(${googleAdsKeywords.keywordMatchType})`,
      ...factAggregateFields(googleAdsDailyKeyword),
    })
    .from(googleAdsDailyKeyword)
    .leftJoin(
      googleAdsKeywords,
      and(
        eq(googleAdsKeywords.projectId, googleAdsDailyKeyword.projectId),
        eq(googleAdsKeywords.customerId, googleAdsDailyKeyword.customerId),
        eq(
          googleAdsKeywords.keywordResourceId,
          googleAdsDailyKeyword.keywordResourceId,
        ),
      ),
    )
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("keyword", googleAdsDailyKeyword),
    )
    .where(windowWhere(googleAdsDailyKeyword, scope, w))
    .groupBy(
      googleAdsDailyKeyword.keywordResourceId,
      googleAdsDailyKeyword.campaignResourceId,
      googleAdsDailyKeyword.adGroupResourceId,
    )
    .orderBy(asc(googleAdsDailyKeyword.keywordResourceId));
  return rows.map((row) => ({
    keywordResourceId: row.keywordResourceId,
    campaignResourceId: row.campaignResourceId,
    adGroupResourceId: row.adGroupResourceId,
    keywordText: row.keywordText,
    keywordMatchType: row.keywordMatchType,
    sums: toSums(row),
  }));
}

export async function sumSearchTermWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
  options: GoogleAdsReadOptions = {},
): Promise<GoogleAdsSearchTermTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      campaignResourceId: googleAdsDailySearchTerm.campaignResourceId,
      adGroupResourceId: googleAdsDailySearchTerm.adGroupResourceId,
      searchText: googleAdsDailySearchTerm.searchText,
      keywordText: sql<
        string | null
      >`max(${googleAdsDailySearchTerm.keywordText})`,
      keywordMatchType: sql<
        string | null
      >`max(${googleAdsDailySearchTerm.keywordMatchType})`,
      ...factAggregateFields(googleAdsDailySearchTerm),
    })
    .from(googleAdsDailySearchTerm)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("search_term", googleAdsDailySearchTerm),
    )
    .where(
      and(
        windowWhere(googleAdsDailySearchTerm, scope, w),
        options.searchText !== undefined
          ? eq(googleAdsDailySearchTerm.searchText, options.searchText)
          : undefined,
        options.searchTextLike !== undefined
          ? like(
              googleAdsDailySearchTerm.searchText,
              `%${options.searchTextLike}%`,
            )
          : undefined,
      ),
    )
    .groupBy(
      googleAdsDailySearchTerm.campaignResourceId,
      googleAdsDailySearchTerm.adGroupResourceId,
      googleAdsDailySearchTerm.searchText,
    )
    .orderBy(asc(googleAdsDailySearchTerm.searchText));
  return rows.map((row) => ({
    campaignResourceId: row.campaignResourceId,
    adGroupResourceId: row.adGroupResourceId,
    searchText: row.searchText,
    keywordText: row.keywordText,
    keywordMatchType: row.keywordMatchType,
    sums: toSums(row),
  }));
}

export async function sumDeviceWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
  options: GoogleAdsReadOptions = {},
): Promise<GoogleAdsDeviceTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      device: googleAdsDailyDevice.device,
      ...factAggregateFields(googleAdsDailyDevice),
    })
    .from(googleAdsDailyDevice)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("device", googleAdsDailyDevice),
    )
    .where(
      and(
        windowWhere(googleAdsDailyDevice, scope, w),
        options.campaignResourceId !== undefined
          ? eq(
              googleAdsDailyDevice.campaignResourceId,
              options.campaignResourceId,
            )
          : undefined,
      ),
    )
    .groupBy(googleAdsDailyDevice.device)
    .orderBy(asc(googleAdsDailyDevice.device));
  return rows.map((row) => ({ device: row.device, sums: toSums(row) }));
}

export async function sumLandingPageByResourceWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
  options: GoogleAdsReadOptions = {},
): Promise<GoogleAdsLandingPageByResourceTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      campaignResourceId: googleAdsDailyLandingPage.campaignResourceId,
      ...factAggregateFields(googleAdsDailyLandingPage),
    })
    .from(googleAdsDailyLandingPage)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("landing_page", googleAdsDailyLandingPage),
    )
    .where(
      and(
        windowWhere(googleAdsDailyLandingPage, scope, w),
        options.campaignResourceId !== undefined
          ? eq(
              googleAdsDailyLandingPage.campaignResourceId,
              options.campaignResourceId,
            )
          : undefined,
      ),
    )
    .groupBy(googleAdsDailyLandingPage.campaignResourceId)
    .orderBy(asc(googleAdsDailyLandingPage.campaignResourceId));
  return rows.map((row) => ({
    campaignResourceId: row.campaignResourceId,
    sums: toSums(row),
  }));
}

export async function sumLandingPageByUrlWindow(
  scope: GoogleAdsUnitScope,
  window: GoogleAdsFactsWindow,
  options: GoogleAdsReadOptions = {},
): Promise<GoogleAdsLandingPageTotals[]> {
  googleAdsUnitScopeSchema.parse(scope);
  const w = googleAdsFactsWindowSchema.parse(window);
  const rows = await db
    .select({
      landingPageUrl: googleAdsDailyLandingPage.landingPageUrl,
      ...factAggregateFields(googleAdsDailyLandingPage),
    })
    .from(googleAdsDailyLandingPage)
    .innerJoin(
      googleAdsAnalyticsUnits,
      publishedUnitJoin("landing_page", googleAdsDailyLandingPage),
    )
    .where(
      and(
        windowWhere(googleAdsDailyLandingPage, scope, w),
        options.campaignResourceId !== undefined
          ? eq(
              googleAdsDailyLandingPage.campaignResourceId,
              options.campaignResourceId,
            )
          : undefined,
      ),
    )
    .groupBy(googleAdsDailyLandingPage.landingPageUrl)
    .orderBy(asc(googleAdsDailyLandingPage.landingPageUrl));
  return rows.map((row) => ({
    landingPageUrl: row.landingPageUrl,
    sums: toSums(row),
  }));
}

/** Deletes fact rows whose generation was never published (stale staging
 *  from failed or superseded publish attempts). Bounded to one scope; runs
 *  only after a REAL publish failure has been observed. */
export async function cleanupUnpublishedGenerations(
  scope: GoogleAdsUnitScope,
): Promise<number> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  let deleted = 0;
  for (const grain of GOOGLE_ADS_GRAINS) {
    const table: FactTable = FACT_TABLES[grain];
    const rows = await db
      .delete(table)
      .where(
        and(
          eq(table.projectId, s.projectId),
          eq(table.customerId, s.customerId),
          sql`NOT EXISTS (SELECT 1 FROM ${googleAdsAnalyticsUnits} WHERE ${googleAdsAnalyticsUnits.projectId} = ${table.projectId} AND ${googleAdsAnalyticsUnits.customerId} = ${table.customerId} AND ${googleAdsAnalyticsUnits.date} = ${table.date} AND ${googleAdsAnalyticsUnits.grain} = ${grain} AND ${googleAdsAnalyticsUnits.publishedGenerationId} = ${table.generationId})`,
        ),
      )
      .returning({ id: table.id });
    deleted += rows.length;
  }
  return deleted;
}

export const GoogleAdsAnalyticsRepository = {
  publishUnit,
  recordUnitFailure,
  upsertAccountSnapshot,
  upsertCampaigns,
  upsertAdGroups,
  upsertKeywords,
  getUnit,
  listUnits: selectUnitsSafe,
  getAccountSnapshot,
  sumAccountWindow,
  sumAccountByDate,
  sumCampaignWindow,
  sumAdGroupWindow,
  sumKeywordWindow,
  sumSearchTermWindow,
  sumDeviceWindow,
  sumLandingPageByResourceWindow,
  sumLandingPageByUrlWindow,
  cleanupUnpublishedGenerations,
};
