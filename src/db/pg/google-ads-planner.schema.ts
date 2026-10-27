import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Postgres mirror of src/db/google-ads-planner.schema.ts. The two files MUST
// stay structurally interchangeable: schema-parity.test.ts fails loudly when
// they drift. See the Google Ads storage notes there.
//
// int64 metrics (search volumes, competition index, micros of money) use
// bigint in mode:"number" — NOT integer32/real32 — because a large cost or
// bid micros value easily exceeds the 2^31 int32 range. SQLite's dynamic
// integer carries full safe-integer precision, so both backends round-trip
// javascript-number int64 volumes and micros exactly.

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const plannerTimestamps = {
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
};

// int64 columns in mode:"number" — mirrors sqlite integer semantics.
const int64 = (name: string) => bigint(name, { mode: "number" });

export const GOOGLE_ADS_PLANNER_DATA_TYPES = [
  "keyword_ideas",
  "keyword_metrics",
] as const;

export type GoogleAdsPlannerDataType =
  (typeof GOOGLE_ADS_PLANNER_DATA_TYPES)[number];

export const googleAdsPlannerObservations = pgTable(
  "google_ads_planner_observations",
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
    dataType: text("data_type").notNull(),
    currencyCode: text("currency_code"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    network: text("network").notNull(),
    contractVersion: text("contract_version").notNull(),
    seedKeyword: text("seed_keyword").notNull().default(""),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    partial: boolean("partial").notNull().default(false),
    malformedKeywordCount: int64("malformed_keyword_count")
      .notNull()
      .default(0),
    duplicateKeywordCount: int64("duplicate_keyword_count")
      .notNull()
      .default(0),
    missingKeywordCount: int64("missing_keyword_count").notNull().default(0),
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

export const googleAdsPlannerGroups = pgTable(
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
    keyword: text("keyword").notNull(),
    avgMonthlySearches: int64("avg_monthly_searches"),
    competition: text("competition"),
    competitionIndex: int64("competition_index"),
    averageCpcMicros: int64("average_cpc_micros"),
    lowTopOfPageBidMicros: int64("low_top_of_page_bid_micros"),
    highTopOfPageBidMicros: int64("high_top_of_page_bid_micros"),
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

export const googleAdsPlannerGroupVariants = pgTable(
  "google_ads_planner_group_variants",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => googleAdsPlannerGroups.id, { onDelete: "cascade" }),
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

export const googleAdsPlannerGroupMonths = pgTable(
  "google_ads_planner_group_months",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => googleAdsPlannerGroups.id, { onDelete: "cascade" }),
    year: int64("year").notNull(),
    month: int64("month").notNull(),
    volume: int64("volume"),
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
