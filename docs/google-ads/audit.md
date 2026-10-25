# Google Ads implementation evidence — 2026-10-21

Source: user master plan; starting commit 8ef5cbe6 on feat/ga4-settings-and-gsc-performance-fixes.
Authorized implementer: OpenCode opencode/glm-5.3-flash-free, explicitly selected by the user on 2026-10-23 after the refreshed OpenCode catalog no longer listed the previously selected MiniMax free model. Orchestrator reviews and commits; no push, merge or deploy. No live Ads calls until Cloud access and OAuth are verified. TODO MCP tools are not exposed in this session; no .todo access.

GOOGLE_ADS_EXISTING_INTEGRATION = PARTIAL
GOOGLE_OAUTH_REUSABLE = YES
ACCOUNT_DISCOVERY = MISSING
KEYWORD_PLANNER = PARTIAL
ADS_ANALYTICS_BACKEND = MISSING
ADS_STORED_SYNC = MISSING
ADS_UI = MISSING
REPORTS_INTEGRATION = MISSING
SAM_INTEGRATION = MISSING
GOOGLE_CLOUD_API_ACCESS = NOT_VERIFIED

Audit evidence:

- src/server/lib/seo-data/providers/google-ads-provider.ts:28 pins v18; :30-62 global credentials; :168 raw ideas; :222 wrong historical body and no targeting; :238 low bid mislabeled CPC; :294 Labs exclusion only.
- src/lib/auth-config.ts:19 encrypted OAuth, :38-61 separate GSC/GA4 providers with PKCE/offline access.
- src/server/features/gsc/selfHostedOAuth.ts:139-164 project-bound nonce; :159/:214 hardcoded ga4 state identifier needs scoped extension.
- src/server/features/ga4/services/Ga4Service.ts:124-158 validates resource access before selection; repositories/Ga4ConnectionRepository.ts:7-18 org scoping.
- src/server.ts:195-199 schedules GSC/GA4 directly; only SiteAudit/RankCheck/Autopilot have Workflow exports at :178-180.
- src/shared/reports.ts:48-76 no Ads sections; reports/services/reportSections.ts:97-160 stored GA4 collector.
- src/server/features/sam/samChatTools.ts:292-368 explicit tools require Ads adaptation.
- src/server/features/intelligence/services/SourceTokens.ts:26-32 no Ads source; existing detector registry and canonical page identities must be extended.

Verified official documentation:

- https://developers.google.com/google-ads/api/docs/release-notes v26 released 2026-10-14.
- https://developers.google.com/google-ads/api/docs/api-policy/developer-token developer tokens sunset 2026-09-09; header optional and ignored; access tied to OAuth Cloud project.
- https://developers.google.com/google-ads/api/docs/api-policy/access-levels Explorer excludes KeywordPlanIdeaService; Planner requires appropriate Basic/Standard access.

Implementation sequence: (1) secure OAuth/customer connection, (2) planner transport/routing/semantics, (3) normalized reporting+durable sync, (4) stored UI, (5) existing Intelligence Engine/Reports/SAM frozen evidence. Independent reviewable commits after verified gates.

Ruling: preserve existing DataForSEO location-coverage helper and SERP/rank routing; Google Ads eligibility must be separate.
Ruling: use fixtures only while live Cloud/OAuth permissions remain unverified.

Baseline full-suite run in original checkout was stopped after resource-heavy startup and existing timeout failures; it did not complete. Named timeout files: GscService.test.ts (3), RankCheckWorkflow.test.ts (4), output-schema-validation.test.ts (1), reportsSchedulesMigration.test.ts (1), mcp/transport.test.ts (1), plus beforeAll failures/skips in ShareService, ReportService, detectorInputs. No feature code existed at that point. Full logs: baseline-tests.log. Later verification must use bounded workers and report actual outcomes.
Phase1 dispatch attempt 1: preflight timeout (OpenCode --version exceeded relay 10s cap); no implementer dispatched, no production edits. Retry after install/resource pressure settles.

MISSING_FEATURES = Ads-specific OAuth and encrypted grant linkage; customer/manager discovery and project account selection; valid v26 Planner transport and consumer normalization; account-scoped normalized reporting and durable sync/coverage; stored Ads UI; Ads evidence in existing Intelligence Engine/Reports/SAM; deterministic security/semantic/E2E verification; live Cloud/OAuth validation.
IMPLEMENTATION_PR_BREAKDOWN = 1) secure OAuth/customer connection foundation; 2) first-party Keyword Planner and keyword contracts/cache; 3) stored analytics and durable sync; 4) project analytics/settings UI and browser fixtures; 5) existing Intelligence Engine, immutable Reports and SAM read-only evidence; 6) integrated verification and acceptance evidence. Local reviewable commits; no automatic push/merge/deploy.

Baseline verification update: isolated C: worktree auth/schema suite passed 4 files and 284 tests with maxWorkers=2. The same subset on the original F: checkout timed out (283 passed, 1 failed, 1 error); this supports an environment-related timing explanation, not a confirmed application defect.

OpenCode review correction: Search v26 rejects pageSize/page_size (PAGE_SIZE_NOT_SUPPORTED); use fixed pages and pageToken only. CustomerClient.level is int64 and REST may encode it as a string. Official references: https://developers.google.com/google-ads/api/reference/rpc/v26/SearchGoogleAdsRequest and https://developers.google.com/google-ads/api/reference/rpc/v26/CustomerClient .

Review control: global LiveReview hook required a genuine staged review; completed review 13177 and committed audit at 7d8820db. No --skip or --vouch used. Review annotations restate known plan gaps; they do not establish a production vulnerability in newly committed documentation. Organization-enforced Greptile baseline has not been verified; no review-control configuration changed.

Additional reporting contracts verified on 2026-10-22:

- [Resource-specific landing page fields](https://developers.google.com/google-ads/api/fields/v26/landing_page_view) support a daily URL grain with impressions, clicks, cost, conversions and conversion value. Selecting campaign or ad-group fields further segments the data, so storage keys must include those dimensions when selected. The generic field compatibility lists do not establish that every listed field is valid for a particular FROM resource.
- [Reporting segmentation](https://developers.google.com/google-ads/api/docs/reporting/segmentation) makes search-term rows specific to ad groups. Identical term text across groups must retain its distinct source grain.
- [Zero-metric reporting](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics) omits rows whose selected metrics are all zero in segmented reports. Completed query coverage can represent an empty day; failed or partial queries cannot. Refreshing a completed window must also remove obsolete facts, rather than retaining them through upsert-only writes. Daily granular backfill is subject to the documented 37-month retention limit.
- [Rate-limit guidance](https://developers.google.com/google-ads/api/docs/productionize/rate-limits) identifies RESOURCE_TEMPORARILY_EXHAUSTED as transient. A generic RESOURCE_EXHAUSTED/HTTP429 alone does not prove a retry will succeed. [Quota documentation](https://developers.google.com/google-ads/api/docs/best-practices/quotas) distinguishes valid pagination requests from initial operations and invalid page tokens; local request counters are not authoritative remaining-quota estimates.

Verification checkpoint: the isolated worktree passed 28 focused SAM/client/OAuth tests and types:check after declaring the already-locked throttleit test dependency (a7db2265). Touched-file lint subsequently reported 46 errors in the unfinished OAuth/client changes. These results are not acceptance of the account foundation or the complete integration. Live account verification remains pending.

Verification update — 2026-10-23: an independent run passed 421 tests across 16 focused account, OAuth, repository, schema-parity, Planner and authorization suites. Types check exited successfully, and targeted Ads lint reported zero warnings and zero errors. The account client was committed separately at 99c6a876 after genuine LiveReview. These checks do not cover the full integration: the legacy provider/router path, stored analytics, sync, UI and downstream evidence remain unfinished.

Subsequent review reproduced three additional Planner defects with failing tests: omitted repeated result fields were rejected despite valid ProtoJSON empty-list semantics, and a sole non-targetable language was accepted. Corrections and behavioral positive-handler authorization tests are delegated. Earlier passing test totals do not establish that these additional cases are correct.

Commit blocker: LiveReview request 13209 rejected the OAuth/persistence review because its monthly allowance had 143 lines remaining against a 20,822-line request, including generated snapshots. No review hook was bypassed and no paid upgrade was attempted. Implementation and local verification continue; further commits await an available review allowance or an explicitly approved review-policy decision.

Verification completion — 2026-10-25:

- User authorized continuing commits with `lrc review --skip` after LiveReview monthly LOC quota exhaustion while maintaining full local test, type, lint, and browser verification gates.
- Completed isolated commits on `codex/google-ads-integration`:
  - `0c9a0107` — OAuth callback and connection/grant persistence (`0064`/`0042` D1/PG migrations, encrypted refresh tokens, state protection).
  - `fad407a4` — Account discovery, manager/client hierarchy selection, and connection server functions (`100/100` tests passed).
  - `1eacb6ec` — Keyword Planner and v26 daily reporting client methods (`114/114` tests passed).
  - `08d322c2` — First-party Google Ads Keyword Planner routed through `DataRouter` with cache envelope and provider fallback (`276/276` tests passed).
  - `2f692682` — Normalized analytics and sync storage (`0065`/`0043` migrations, campaign/ad-group/keyword/search-term/landing-page daily facts, sync runs/coverage, `414/414` tests passed).
  - `82f4f354` — Phase 5 SEO/PPC Intelligence Engine integration (`google_ads` source token, `googleAdsCoverage`, `paidOrganicQueryGap`, `paidLandingPageTechnicalIssue`, `365/365` tests passed).
  - `7c161b2c` — Phase 2 (`02c`) normalized Keyword Planner observations (`0066`/`0044` migrations, `GoogleAdsPlannerKeywordRepository`, serving helper, saved-keywords/MCP enrichment, `442/442` tests passed).
  - `8dfa078c` — Phase 3/7 (`03c`) durable sync orchestration, scheduled cron, incremental & backfill windows, and stored analytics server functions (`101/101` tests passed).
  - `5f5e0b73` — Phase 6 (`06a`) stored Paid Search report section, print/markdown export, SAM read-only tools, and monthly performance review integration (`45/45` tests passed).
  - `1a1ac27d` — Phase 4 (`04a`) project settings connection UI, `/p/$projectId/google-ads` analytics dashboard, and Playwright E2E (`50/50` unit tests and `2/2` Playwright E2E tests passed).
- Final status:
  - `GOOGLE_ADS_CONNECTION = PASS`
  - `GOOGLE_ADS_KEYWORD_PLANNER = PASS`
  - `GOOGLE_ADS_ANALYTICS = PASS`
  - `GOOGLE_ADS_SYNC = PASS`
  - `GOOGLE_ADS_UI = PASS`
  - `SEO_PPC_INTELLIGENCE = PASS`
  - `SECURITY = PASS`
  - `LIVE_ACCOUNT_VERIFICATION = PENDING` (deterministic fixtures verified; live Google Cloud project / OAuth production credentials remain external).
