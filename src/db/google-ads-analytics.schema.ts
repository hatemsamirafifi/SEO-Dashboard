import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Google Ads stored analytics storage (master plan phase 3).
//
// Normalized model:
// - One account-metadata snapshot per (project, customer).
// - Campaign / ad-group / keyword dimensions with explicit relationship id
//   columns (verbatim Google Ads resource-name strings).
// - Distinct daily fact grains: account, campaign, ad-group, keyword,
//   search-term, device, landing-page. Grains are NEVER summed together.
// - One unit pointer per (project, customer, date, grain) that publishes a
//   complete day+grain atomically via a generation pointer. Fact rows carry
//   the generation id of the sync that staged them; readers join the pointer
//   so they only ever see rows from the last successfully published
//   generation. Failed or stale generations stay invisible until the pointer
//   flips.
//
// Base metrics are nullable: null means "the source query did not report the
// metric for this row", never zero. Conversions and conversion values are
// fractional REALs. Conversion value is stored AS the currency value (not
// micros). Cost stays in micros.
//
// OAuth tokens and grants are NOT stored here (see better-auth `account`);
// the google_ads_connections table maps projects to customers.
const analyticsTimestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
};

// Account metadata observed from the Ads API. Missing currency or time zone is
// stored as NULL and must surface as explicitly unknown downstream — never as
// a guessed default.
export const googleAdsAccounts = sqliteTable(
  "google_ads_accounts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Ten-digit Ads customer id (bare digits, same normalization as
    // google_ads_connections.customer_id).
    customerId: text("customer_id").notNull(),
    descriptiveName: text("descriptive_name"),
    currencyCode: text("currency_code"),
    timeZone: text("time_zone"),
    isTestAccount: integer("is_test_account", { mode: "boolean" })
      .notNull()
      .default(false),
    // ISO-8601 instant at which the metadata was read from the Ads API.
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

// Campaign dimension. One row per Ads campaign resource seen for the
// (project, customer) scope. `servingStatus` and `status` are the verbatim
// Ads enum strings (e.g. ENABLED/PAUSED/REMOVED, SERVING/NONE).
export const googleAdsCampaigns = sqliteTable(
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
    // Verbatim resource name, e.g. "customers/1234567890/campaigns/123".
    campaignResourceId: text("campaign_resource_id").notNull(),
    // Source int64 campaign id rendered as string.
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

// Ad-group dimension, explicitly related to its campaign resource.
export const googleAdsAdGroups = sqliteTable(
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

// Advertising-keyword dimension (ad_group_criterion resource) with an explicit
// chain ad group -> campaign.
export const googleAdsKeywords = sqliteTable(
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
    // Verbatim Ads keyword match type enum (EXACT/PHRASE/BROAD) or null.
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
  // ISO-8601 date (YYYY-MM-DD) in the ACCOUNT's time zone (segments.date
  // semantics). Calendar math must stay inclusive on these strings.
  date: text("date").notNull(),
  // Id of the staging generation that produced this row. Rows only become
  // readable when the unit pointer publishes this generation id.
  generationId: text("generation_id").notNull(),
};

const nullableMetricColumns = {
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  // Micros of the account currency as a bounded safe integer.
  costMicros: integer("cost_micros"),
  // Fractional conversions allowed (REAL).
  conversions: real("conversions"),
  // Conversion value ALREADY in currency units — not micros.
  conversionsValue: real("conversions_value"),
};

// Daily account grain (FROM customer + segments.date).
export const googleAdsDailyAccount = sqliteTable(
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

// Daily campaign grain.
export const googleAdsDailyCampaign = sqliteTable(
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

// Daily ad-group grain (explicit campaign + ad-group relationship).
export const googleAdsDailyAdGroup = sqliteTable(
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

// Daily advertising-keyword grain.
export const googleAdsDailyKeyword = sqliteTable(
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

// Daily search-term grain. Recommend keeping the full composite key:
// the same term text across ad groups (or campaigns) is a distinct source row
// because the Ads search_term_view is implicitly segmented by ad group.
// `keywordText`/`keywordMatchType` are the matched keyword attributes
// returned on the row; they are informational, not part of the grain.
export const googleAdsDailySearchTerm = sqliteTable(
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

// Daily device grain at the campaign level (FROM campaign segmented by
// segments.device). Never summed together with other grains.
export const googleAdsDailyDevice = sqliteTable(
  "google_ads_daily_device",
  {
    id: text("id").primaryKey(),
    ...dailyFactColumns,
    campaignResourceId: text("campaign_resource_id").notNull(),
    // Verbatim Ads Device enum string (DESKTOP/MOBILE/TABLET/...).
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

// Daily landing-page grain at the campaign level (FROM landing_page_view with
// campaign fields selected). `landingPageUrl` keeps the FULL source URL; URL
// canonicalization is owned downstream by the existing canonical page identity
// service, never here.
export const googleAdsDailyLandingPage = sqliteTable(
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

// Published-unit pointer, one per (project, customer, date, grain). This is
// the coverage ledger: it records the generation currently published for the
// unit, its source fetch timestamp, the account currency at fetch time, and
// the conversion metric date basis. Statuses:
// pending -> success_with_data | success_zero_rows | failed | partial.
// Downstream readers accept ONLY success_* (or the pointer's published rows
// through the storage join) — a failed or partial unit never becomes known
// zero; a complete empty unit publishes success_zero_rows.
export const googleAdsAnalyticsUnits = sqliteTable(
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
    // Generation currently published for this unit; NULL when nothing has
    // ever been published successfully.
    publishedGenerationId: text("published_generation_id"),
    status: text("status").notNull().default("pending"),
    // Errors are bounded classes only; details live in the sync ledger.
    errorClass: text("error_class"),
    rowCount: integer("row_count").notNull().default(0),
    sourceFetchedAt: text("source_fetched_at"),
    currencyCode: text("currency_code"),
    // How the source attributed day values for conversion metrics
    // ('interaction_date' | 'conversion_date'); NULL when not known.
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
