import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Google Ads Keyword Planner first-party storage (master plan phase 2).
//
// Normalized model — actual canonical keyword GROUP observations, never
// generic unscoped keyword_metrics rows:
// - One observation row per (project, customer, data type, seed, market
//   scope): the provenance ledger a fresh planner fetch produced.
// - One keyword-group row per canonical keyword inside that scope. Google's
//   planner reports metrics for a GROUP of close variants; the canonical
//   group carries the shared estimate.
// - Variant membership is an explicit relational table (group -> variant), so
//   "this saved keyword belongs to that canonical group" is a JOIN, never a
//   JSON array.
// - Monthly search history is an explicit relational table (group -> month),
//   so history survives joins instead of nested JSON strings.
//
// Honesty rules (same basis as google-ads-analytics):
// - Absent upstream metrics stay NULL, never zero. A null volume for a month
//   means Google reported no data — a REAL zero stays zero.
// - Money stays in micros of the account currency; the currency is stored
//   alongside, never assumed to be USD.
// - `competition` is the Ads advertising-competition enum (LOW/MEDIUM/HIGH)
//   and `competitionIndex` its 0-100 index — NOT organic keyword difficulty.
// - `sourceFetchedAt` is the serving planner's fetch timestamp. Reads never
//   refresh it; only a fresh observation may overwrite it.
//
// OAuth tokens, grants and connections live elsewhere (better-auth `account`
// and google_ads_connections); the trusted Ads identity (customer, login
// manager, currency) is resolved server-side from the project's connection —
// client-supplied customer or grant ids are never trusted here.
const plannerTimestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
};

/** The keyword flows a planner observation was produced for. */
export const GOOGLE_ADS_PLANNER_DATA_TYPES = [
  "keyword_ideas",
  "keyword_metrics",
] as const;

export type GoogleAdsPlannerDataType =
  (typeof GOOGLE_ADS_PLANNER_DATA_TYPES)[number];

// Observation ledger: one fresh planner answer, scoped by everything that
// changes the numbers (account identity, market, network, payload contract).
export const googleAdsPlannerObservations = sqliteTable(
  "google_ads_planner_observations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Ten-digit Ads customer id (bare digits), same normalization as
    // google_ads_connections.customer_id.
    customerId: text("customer_id").notNull(),
    // Manager id used as the login customer, when the connection rides a
    // manager hierarchy.
    loginCustomerId: text("login_customer_id"),
    // "keyword_ideas" | "keyword_metrics".
    dataType: text("data_type").notNull(),
    // Currency of the selected Ads account — money provenance, never
    // defaulted.
    currencyCode: text("currency_code"),
    // SEO catalog location code the research layer asked with (the Google
    // geo target constant it resolves to lives client-side in the cached
    // envelope; scoping stays on the catalog code for readability).
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    // GOOGLE_SEARCH_AND_PARTNERS (the recorded planner default).
    network: text("network").notNull(),
    contractVersion: text("contract_version").notNull(),
    // Seed the ideas walk was seeded with ("" for keyword_metrics calls).
    seedKeyword: text("seed_keyword").notNull().default(""),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    // Honesty flags from the envelope: NOT everything Google could answer.
    truncated: integer("truncated", { mode: "boolean" })
      .notNull()
      .default(false),
    partial: integer("partial", { mode: "boolean" }).notNull().default(false),
    malformedKeywordCount: integer("malformed_keyword_count")
      .notNull()
      .default(0),
    duplicateKeywordCount: integer("duplicate_keyword_count")
      .notNull()
      .default(0),
    missingKeywordCount: integer("missing_keyword_count").notNull().default(0),
    ...plannerTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_planner_observations_scope_idx").on(
      table.projectId,
      table.customerId,
      table.dataType,
      table.seedKeyword,
      table.locationCode,
      table.languageCode,
      table.network,
      table.contractVersion,
    ),
    index("google_ads_planner_observations_organization_idx").on(
      table.organizationId,
    ),
  ],
);

// Canonical keyword group observation. One row per canonical keyword inside
// the (project, customer, market, network, contract) scope.
export const googleAdsPlannerGroups = sqliteTable(
  "google_ads_planner_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    loginCustomerId: text("login_customer_id"),
    currencyCode: text("currency_code"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    network: text("network").notNull(),
    contractVersion: text("contract_version").notNull(),
    // Canonical group text (normalized keyword identity, same lowercase
    // identity the keyword flow uses).
    keyword: text("keyword").notNull(),
    // Average monthly searches over the last 12 months; null when absent.
    avgMonthlySearches: integer("avg_monthly_searches"),
    // Advertising competition enum: LOW/MEDIUM/HIGH.
    competition: text("competition"),
    // Advertising competition index 0-100 (NOT keyword difficulty).
    competitionIndex: integer("competition_index"),
    // Micros of the account currency, precisely stored (int64-safe).
    averageCpcMicros: integer("average_cpc_micros"),
    lowTopOfPageBidMicros: integer("low_top_of_page_bid_micros"),
    highTopOfPageBidMicros: integer("high_top_of_page_bid_micros"),
    // The serving fetch timestamp of the observation that produced/overwrote
    // this row. Reads never refresh it.
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...plannerTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_planner_groups_scope_keyword_idx").on(
      table.projectId,
      table.customerId,
      table.locationCode,
      table.languageCode,
      table.network,
      table.contractVersion,
      table.keyword,
    ),
    index("google_ads_planner_groups_organization_idx").on(
      table.organizationId,
    ),
    index("google_ads_planner_groups_keyword_idx").on(
      table.projectId,
      table.customerId,
      table.keyword,
    ),
  ],
);

// Explicit variant membership: which literal keywords share the canonical
// group's estimate. Aggregate/resize semantics live on the group row only.
export const googleAdsPlannerGroupVariants = sqliteTable(
  "google_ads_planner_group_variants",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => googleAdsPlannerGroups.id, { onDelete: "cascade" }),
    // Normalized variant text (same identity space as the group keyword).
    variantKeyword: text("variant_keyword").notNull(),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...plannerTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_planner_group_variants_group_variant_idx").on(
      table.groupId,
      table.variantKeyword,
    ),
    index("google_ads_planner_group_variants_variant_idx").on(
      table.variantKeyword,
    ),
  ],
);

// Explicit monthly history: known calendar months with their volume. A null
// volume means Google reported no data for that month — never fabricated to
// zero.
export const googleAdsPlannerGroupMonths = sqliteTable(
  "google_ads_planner_group_months",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => googleAdsPlannerGroups.id, { onDelete: "cascade" }),
    // Calendar year (e.g. 2026).
    year: integer("year").notNull(),
    // Calendar month 1-12.
    month: integer("month").notNull(),
    // Searches in that month; null when unavailable.
    volume: integer("volume"),
    ...plannerTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_planner_group_months_group_month_idx").on(
      table.groupId,
      table.year,
      table.month,
    ),
    index("google_ads_planner_group_months_group_idx").on(table.groupId),
  ],
);
