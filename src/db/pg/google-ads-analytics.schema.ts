import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Postgres mirror of src/db/google-ads-analytics.schema.ts. The two files
// MUST stay structurally interchangeable: schema-parity.test.ts fails loudly
// when they drift. See the Google Ads storage notes there.

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const analyticsTimestamps = {
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
};

export const googleAdsAccounts = pgTable(
  "google_ads_accounts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    descriptiveName: text("descriptive_name"),
    currencyCode: text("currency_code"),
    timeZone: text("time_zone"),
    isTestAccount: boolean("is_test_account").notNull().default(false),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_accounts_project_customer_idx").on(
      table.projectId,
      table.customerId,
    ),
    index("google_ads_accounts_organization_idx").on(table.organizationId),
  ],
);

export const googleAdsCampaigns = pgTable(
  "google_ads_campaigns",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    campaignResourceId: text("campaign_resource_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    servingStatus: text("serving_status"),
    advertisingChannelType: text("advertising_channel_type"),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_campaigns_resource_idx").on(
      table.projectId,
      table.customerId,
      table.campaignResourceId,
    ),
    index("google_ads_campaigns_organization_idx").on(table.organizationId),
  ],
);

export const googleAdsAdGroups = pgTable(
  "google_ads_ad_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    adGroupResourceId: text("ad_group_resource_id").notNull(),
    campaignResourceId: text("campaign_resource_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_ad_groups_resource_idx").on(
      table.projectId,
      table.customerId,
      table.adGroupResourceId,
    ),
    index("google_ads_ad_groups_campaign_idx").on(
      table.projectId,
      table.customerId,
      table.campaignResourceId,
    ),
  ],
);

export const googleAdsKeywords = pgTable(
  "google_ads_keywords",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    keywordResourceId: text("keyword_resource_id").notNull(),
    campaignResourceId: text("campaign_resource_id").notNull(),
    adGroupResourceId: text("ad_group_resource_id").notNull(),
    keywordText: text("keyword_text").notNull(),
    keywordMatchType: text("keyword_match_type"),
    sourceFetchedAt: text("source_fetched_at").notNull(),
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_keywords_resource_idx").on(
      table.projectId,
      table.customerId,
      table.keywordResourceId,
    ),
    index("google_ads_keywords_ad_group_idx").on(
      table.projectId,
      table.customerId,
      table.adGroupResourceId,
    ),
  ],
);

const dailyFactColumns = {
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull(),
  date: text("date").notNull(),
  generationId: text("generation_id").notNull(),
};

// Google Ads integer metrics are int64 (cost in micros overflows a signed
// 32-bit PG integer above 2,147.483647 currency units); conversions and
// conversion values are DOUBLE precision because PG real is float32.
const nullableMetricColumns = {
  impressions: bigint("impressions", { mode: "number" }),
  clicks: bigint("clicks", { mode: "number" }),
  costMicros: bigint("cost_micros", { mode: "number" }),
  conversions: doublePrecision("conversions"),
  conversionsValue: doublePrecision("conversions_value"),
};

export const googleAdsDailyAccount = pgTable(
  "google_ads_daily_account",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_account_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.generationId,
    ),
    index("google_ads_daily_account_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsDailyCampaign = pgTable(
  "google_ads_daily_campaign",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_campaign_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.campaignResourceId,
      table.generationId,
    ),
    index("google_ads_daily_campaign_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
    index("google_ads_daily_campaign_resource_date_idx").on(
      table.projectId,
      table.customerId,
      table.campaignResourceId,
      table.date,
    ),
  ],
);

export const googleAdsDailyAdGroup = pgTable(
  "google_ads_daily_ad_group",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    adGroupResourceId: text("ad_group_resource_id").notNull(),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_ad_group_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.adGroupResourceId,
      table.generationId,
    ),
    index("google_ads_daily_ad_group_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsDailyKeyword = pgTable(
  "google_ads_daily_keyword",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    adGroupResourceId: text("ad_group_resource_id").notNull(),
    keywordResourceId: text("keyword_resource_id").notNull(),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_keyword_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.keywordResourceId,
      table.generationId,
    ),
    index("google_ads_daily_keyword_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsDailySearchTerm = pgTable(
  "google_ads_daily_search_term",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    adGroupResourceId: text("ad_group_resource_id").notNull(),
    searchText: text("search_text").notNull(),
    keywordText: text("keyword_text"),
    keywordMatchType: text("keyword_match_type"),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_search_term_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.campaignResourceId,
      table.adGroupResourceId,
      table.searchText,
      table.generationId,
    ),
    index("google_ads_daily_search_term_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsDailyDevice = pgTable(
  "google_ads_daily_device",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    device: text("device").notNull(),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_device_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.campaignResourceId,
      table.device,
      table.generationId,
    ),
    index("google_ads_daily_device_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsDailyLandingPage = pgTable(
  "google_ads_daily_landing_page",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    landingPageUrl: text("landing_page_url").notNull(),
    ...nullableMetricColumns,
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_daily_landing_page_generation_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.campaignResourceId,
      table.landingPageUrl,
      table.generationId,
    ),
    index("google_ads_daily_landing_page_date_idx").on(
      table.projectId,
      table.customerId,
      table.date,
    ),
  ],
);

export const googleAdsAnalyticsUnits = pgTable(
  "google_ads_analytics_units",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    date: text("date").notNull(),
    grain: text("grain").notNull(),
    publishedGenerationId: text("published_generation_id"),
    status: text("status").notNull().default("pending"),
    errorClass: text("error_class"),
    rowCount: integer("row_count").notNull().default(0),
    sourceFetchedAt: text("source_fetched_at"),
    currencyCode: text("currency_code"),
    metricDateBasis: text("metric_date_basis"),
    stagedAt: text("staged_at"),
    publishedAt: text("published_at"),
    ...analyticsTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_analytics_units_unit_idx").on(
      table.projectId,
      table.customerId,
      table.date,
      table.grain,
    ),
    index("google_ads_analytics_units_grain_status_date_idx").on(
      table.projectId,
      table.grain,
      table.status,
      table.date,
    ),
  ],
);
