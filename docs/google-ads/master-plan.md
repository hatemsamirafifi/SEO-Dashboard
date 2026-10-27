# OpenSEO — Google Ads Integration Master Implementation Plan

## Mission

Add a comprehensive Google Ads integration to OpenSEO, covering:

1. Secure Google Ads account connection.
2. Keyword Planner and historical search metrics.
3. Stored campaign and advertising analytics.
4. Google Ads Analytics UI.
5. SEO/PPC intelligence using GSC and GA4.
6. Read-only integration with Reports and SAM Autopilot.

Follow the existing OpenSEO Constitution and approved architecture.

Do not assume that Google Ads is absent. README and PRD already identify it as a first-party keyword research data source.

## Phase 0 — Repository Audit

Inspect the current checkout and identify:

- Existing Google Ads API clients, provider adapters and services.
- Google OAuth implementation used by GSC and GA4.
- Existing credential storage and encryption.
- Keyword Research provider routing.
- Current Google Ads settings or account connections.
- Analytics sync architecture.
- D1/PostgreSQL schemas.
- Project/org authorization.
- Existing Cloudflare scheduling infrastructure.
- Related MCP tools, Reports and SAM integrations.

Report exact file-level evidence.

Do not build duplicate infrastructure.

Use the current project's codebase as the implementation baseline. Review upstream changes selectively when relevant; do not perform a broad upstream merge as part of this feature.

## Phase 1 — Authentication & Accounts

Use the current Google Ads API v26 documentation.

Important: Google Ads API developer-token onboarding changed in September 2026. Verify the current Google Cloud Project-based access model and avoid reproducing obsolete developer-token requirements.

Implement or complete:

- OAuth 2.0 connection.
- Google Ads API scope and offline refresh.
- Secure encrypted token persistence.
- Available customer account discovery.
- Manager account hierarchy support where authorized.
- Account selection per OpenSEO project.
- Connection testing.
- Authorization error handling.
- Reconnect and disconnect.
- Token revocation and expiry handling.
- Project/org isolation.

The application must remain read-only for Google Ads operations.

No campaign creation, mutation, budget changes or advertising activation.

## Phase 2 — Keyword Planner

Integrate through the existing keyword research/data routing architecture:

- GenerateKeywordIdeas
- GenerateKeywordHistoricalMetrics
- Location and language targeting
- Monthly search history
- Average monthly searches
- Advertising competition and competition index
- CPC and top-of-page bid ranges
- Keyword and URL seeds
- Batch keyword metrics
- Source and fetch timestamp
- Cache and refresh behavior

Important:

- Google Ads competition is NOT Organic Keyword Difficulty.
- Preserve provider-specific metric semantics.
- Never substitute missing metrics with zero.
- Normalize Google geo-target constants separately from DataForSEO location codes.
- Keep currency units explicit.
- Preserve close variants and keyword identity semantics.
- Use bounded requests, caching, and API quota protection.

Prefer using Google Ads as a first-party source when properly connected and eligible. Preserve the existing DataForSEO provider path without changing established SERP or rank-tracking provider behavior.

## Phase 3 — Stored Ads Analytics

Use GoogleAdsService Search/SearchStream with version-validated GAQL queries.

Prioritize stored reporting for:

- Account
- Campaign
- Ad group
- Advertising keywords
- Search terms where available
- Daily performance
- Device breakdown
- Cost
- Impressions
- Clicks
- CTR
- Average CPC
- Conversions
- Conversion value
- CPA
- ROAS

Respect resource-specific reporting constraints.

Search term availability may differ by campaign type and privacy thresholds.

Store normalized daily facts with reliable unique grain keys, account currency, source timestamps, and sync coverage.

Do not incorrectly aggregate rates, distinct counts or ratios.

Derive aggregate rates from compatible base totals.

Add D1/PostgreSQL migrations only where necessary, preserving parity.

## Phase 4 — Google Ads UI

Create or extend the existing project analytics navigation.

Target route, only if absent:

/p/$projectId/google-ads

Provide:

- Account selector and connection status
- Overview KPI cards
- Campaign performance table
- Search term analysis
- Keyword performance
- Device performance
- Spend and conversion trends
- Current vs preceding equal-length period
- Currency-aware formatting
- Sync status, freshness and coverage
- Loading, empty, disconnected, partial, stale and failed states
- Navigation to related GA4 and GSC views

Use stored data for UI queries.

No implicit remote API calls during rendering.

## Phase 5 — SEO/PPC Intelligence

Extend the existing Intelligence Engine to compare:

- Paid search visibility
- Organic GSC performance
- Keyword Planner demand
- GA4 landing-page engagement
- Paid conversion evidence
- Organic opportunities

Potential findings include:

- High-cost paid terms with weak organic visibility.
- Valuable paid search terms that deserve SEO evaluation.
- Important paid landing pages with technical SEO issues.
- Shared paid and organic search themes.

Do not infer causality from correlation.

Do not directly add GSC clicks and Google Ads clicks as if they were interchangeable measurements.

Keep evidence, recommendations, impact and confidence distinct.

Use existing canonical page identity for URL joins.

## Phase 6 — Reports and SAM

Add optional Google Ads sections to stored Reports.

Allow SAM to consume frozen Ads evidence for recommendations and monthly reviews.

Do not authorize SAM to modify campaigns, bids, budgets or advertisements.

Preserve all approval, security, budget and execution controls.

Do not interfere with existing G5 Competitor Gap or G6 Email Delivery gates.

## Phase 7 — Sync, Diagnostics & Quotas

Reuse Cloudflare-native scheduling and durable execution.

Provide:

- Incremental synchronization.
- Historical backfill within supported limits.
- Idempotent run identity.
- Retries for transient errors only.
- API quota and rate-limit handling.
- Reliable account and permission errors.
- Partial sync recovery.
- Credential-safe Global Debug Trace.
- Account-level sync history.
- Quota visibility where supported.
- No duplicate paid or quota-consuming operations.

Do not introduce a new task queue, scheduler or SEO provider.

## Phase 8 — Verification

Test:

- OAuth callback and state protection.
- Expired and revoked credentials.
- Google Cloud API access level restrictions.
- Customer and manager account access.
- Organization/project isolation.
- Keyword ideas and historical metrics normalization.
- Currency conversion from micros.
- API rate-limit and quota exhaustion.
- Campaign and search-term reporting semantics.
- Incremental sync and idempotency.
- Missing data versus real zero.
- GA4 and GSC comparison boundaries.
- Reporting and SAM read-only access.
- D1/PostgreSQL parity.
- Cross-project security.
- No Google Ads mutations.
- Browser UI workflows.

Use deterministic fixtures until real account access is approved.

Do not perform campaign mutations.

## Required First Return

GOOGLE_ADS_EXISTING_INTEGRATION = NONE | PARTIAL | COMPLETE

GOOGLE_OAUTH_REUSABLE = YES | NO

ACCOUNT_DISCOVERY = COMPLETE | PARTIAL | MISSING

KEYWORD_PLANNER = COMPLETE | PARTIAL | MISSING

ADS_ANALYTICS_BACKEND = COMPLETE | PARTIAL | MISSING

ADS_STORED_SYNC = COMPLETE | PARTIAL | MISSING

ADS_UI = COMPLETE | PARTIAL | MISSING

REPORTS_INTEGRATION = COMPLETE | PARTIAL | MISSING

SAM_INTEGRATION = COMPLETE | PARTIAL | MISSING

GOOGLE_CLOUD_API_ACCESS = VERIFIED | NOT_VERIFIED

MISSING_FEATURES = ...

IMPLEMENTATION_PR_BREAKDOWN = ...

Then implement only verified gaps in isolated, reviewable commits.

Before making real Google Ads API calls, verify Google Cloud API access and OAuth permissions. Stop if credentials or API access are unavailable rather than fabricating successful live results.

## Final Acceptance

GOOGLE_ADS_CONNECTION = PASS | PENDING

GOOGLE_ADS_KEYWORD_PLANNER = PASS | PENDING

GOOGLE_ADS_ANALYTICS = PASS | PENDING

GOOGLE_ADS_SYNC = PASS | PENDING

GOOGLE_ADS_UI = PASS | PENDING

SEO_PPC_INTELLIGENCE = PASS | PENDING

SECURITY = PASS | FAIL

TESTS = ...

TYPES_CHECK = ...

LINT = ...

BROWSER_E2E = ...

LIVE_ACCOUNT_VERIFICATION = PASS | PENDING

REMAINING_BLOCKERS = ...

Do not merge, deploy, spend advertising budget, or modify Google Ads campaigns automatically.