# Google Ads implementation evidence — 2026-10-21

Source: user master plan; starting commit 8ef5cbe6 on feat/ga4-settings-and-gsc-performance-fixes.
Authorized implementer: OpenCode opencode/glm-5.3-flash-free. Orchestrator reviews and commits; no push, merge or deploy. No live Ads calls until Cloud access and OAuth are verified. TODO MCP tools are not exposed in this session; no .todo access.

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
