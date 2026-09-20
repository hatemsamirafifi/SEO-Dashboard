# OpenSEO Final Implementation Plan — Integrated Intelligence Platform

> **Status: READY TO IMPLEMENT.** This document is the single consolidated, implementation-binding plan produced across six passes: repository discovery → 22-section development plan → architecture revision (Finding → Insight → Opportunity) → hardening → blocking corrections → consistency patch → pre-implementation patch. All prior pass documents are superseded by this file. Nothing herein has been implemented; the first PRs may begin per §24.
>
> **Scope:** Dashboard Insights · GA4 Analytics · Opportunities Engine · Reports & Agency Features · SAM Autopilot — designed as connected parts of OpenSEO, not isolated features.
>
> **Non-negotiable invariants** (enforced by tests in §19):
> 1. One detector implementation per SEO condition. Dashboard and Opportunities never independently detect the same condition.
> 2. Missing optional data never reduces an opportunity's impact score (available-factor renormalization).
> 3. Impact and confidence remain separately inspectable (`impactScore`, `confidenceScore`); no combined `rankScore` column.
> 4. Opportunity identity stable across scans (partial-unique active occurrence + historical recurrences).
> 5. Provider/API failure never becomes "zero traffic" / "no ranking" / "no opportunity".
> 6. Incomplete coverage reduces confidence or blocks a detector — never silently produces output.
> 7. Reports snapshot already-derived intelligence; SAM consumes structured intelligence, never measures raw data with an LLM.
> 8. Long-running Autopilot survives beyond a single chat turn (Cloudflare Workflow + attempts).
> 9. Deterministic analysis before LLM interpretation; correlation never presented as causation (observational-only default).
> 10. Organization branding and project/client identity never conflated.
> 11. D1/SQLite + PostgreSQL parity on every migration. No new generic job/queue system.

---

## Table of contents

1. [Current architecture baseline](#1-current-architecture-baseline)
2. [Final domain definitions](#2-final-domain-definitions)
3. [Revised target architecture](#3-revised-target-architecture)
4. [Detection engine architecture](#4-detection-engine-architecture)
5. [Persistence decisions](#5-persistence-decisions)
6. [Intelligence run / stage / artifact model](#6-intelligence-run--stage--artifact-model)
7. [Source version tokens & Detection source state](#7-source-version-tokens--detection-source-state)
8. [Scheduler & recompute rules](#8-scheduler--recompute-rules)
9. [GA4 architecture](#9-ga4-architecture)
10. [Opportunities Engine architecture](#10-opportunities-engine-architecture)
11. [Dashboard Insights architecture](#11-dashboard-insights-architecture)
12. [Reports & agency architecture](#12-reports--agency-architecture)
13. [SAM Autopilot architecture](#13-sam-autopilot-architecture)
14. [Database schema](#14-database-schema)
15. [API / server function plan](#15-api--server-function-plan)
16. [MCP plan](#16-mcp-plan)
17. [UI / route plan](#17-ui--route-plan)
18. [Observability plan](#18-observability-plan)
19. [Testing matrix](#19-testing-matrix)
20. [Dependency graph](#20-dependency-graph)
21. [PR breakdown](#21-pr-breakdown)
22. [MVP vs later enhancements](#22-mvp-vs-later-enhancements)
23. [Risks / open questions](#23-risks--open-questions)
24. [Recommended execution order](#24-recommended-execution-order)

---

## 1. Current architecture baseline

Verified against the repository (`open-seo@0.1.3`); implementation must reuse, not duplicate, the following.

### 1.1 Stack, layout, conventions

* TanStack Start + Router (file routes) + React Query + React 19, Vite 7, Cloudflare Workers. Router `src/router.tsx`; middleware `src/start.ts` (`globalServerFunctionMiddleware = [errorHandlingMiddleware, ensureUserMiddleware]`); worker `src/server.ts` (`fetch` + `scheduled` + Workflow/DO exports).
* Canonical backend pattern: `serverFunction (src/serverFunctions/*.ts)` → `Feature Service (src/server/features/*/services/*.ts)` → `Repository (*/repositories/*.ts)` → Drizzle DB (`@/db`). Services never touch `env.DB`.
* Trust boundaries: every `createServerFn({method:"POST"})` uses `.middleware(requireProjectContext | requireAuthenticatedContext)` (`src/serverFunctions/middleware.ts`) + strict Zod validators in `src/types/schemas/*.ts`.
* Project/org scoping: `src/middleware/ensureUser.ts` resolves `data.projectId` via `ProjectRepository.getProjectForOrganization`, throws `NOT_FOUND` on miss; repositories additionally scope `(projectId, organizationId, archivedAt IS NULL)`. Route-level `getProjectAccess` is redirect-only.
* DB parity: `src/db/*.schema.ts` (SQLite/D1) ↔ `src/db/pg/*.schema.ts` (PG); provider switch `src/db/provider.ts`; per-request PG `withPgClient`; writes only via `src/db/runBatch.ts` (`executeInBatches`, 100-statement chunk-atomic batches; **no cross-chunk atomicity**; no `db.batch` outside it — enforced by `schema-parity.test.ts`). Migrations `drizzle/` + `drizzle-pg/` (19 each).
* Tests: Vitest colocated (`src/**/*.test.ts`), Playwright `e2e/`, `pnpm test / test:e2e / ci:check`.

### 1.2 Routes (file-based; project subtree client-only, `ssr:false`)

`/p/$projectId/` (dashboard → `DashboardPage`) · `/search-performance` · `/rank-tracking` (+`index`, `$configId`) · `/keywords`, `/saved` · `/domain` (competitor analysis lives here; **no `/competitors` route**) · `/backlinks` · `/audit` (+`index`, `issues/$resultId`) · `/sam` · `/settings` (with `#search-console`) · `/brand-lookup`, `/prompt-explorer`. Sidebar order: `src/client/navigation/items.ts`. API: `api/auth/$.ts`, `api/gsc/oauth/callback.ts` (self-host only), `api/health.ts`.

### 1.3 Dashboard today

`DashboardPage.tsx` queries `getDashboardActivation` + `getDashboardOverview`; cards in `DashboardCards.tsx` (`OnboardingChecklist`, `McpConnectCard`, `GscCard` reading **live** `getSearchPerformanceReport({dateRange:"last_28_days"})`, `AuditHealthCard` top-3 issues, `BacklinkPulseCard`). `DashboardService.getRankSummary` exists but is **not rendered**. GSC helpers: `searchPerformanceReport.ts` (`sumSearchTotals`, `toDimensionRows`, `buildStrikingDistanceRows` positions 5–20, `previousPeriod`).

### 1.4 GSC + OAuth (the template GA4 reuses)

* Scopes `src/shared/gsc.ts`: exactly `["openid","email","profile","https://www.googleapis.com/auth/webmasters.readonly"]`. **No GA4 scopes exist.**
* Client `src/server/lib/gscClient.ts` (token via `getAccessToken`, auto-refresh, typed `GscApiError/GscTokenError`).
* Services: `GscService`, `GscSyncService.runSync` (7-day chunks, grains `summary|query|page|query_page|country|device`, deterministic `sha256Hex(...).slice(0,36)` fact IDs, checkpoint resume, `classifyGscSyncError`), `gscSyncUtils.ts`, `scheduledGscSync.ts` (per-connection fan-out, skip-if-active).
* Tables: `gsc_connections` (unique `projectId`; tokens live in better-auth `account` rows, `providerId="google-search-console"`), `gsc_search_performance` (upsert key `(projectId,property,searchType,date,grain,grainKey)` + 6 query indexes), `gsc_search_performance_syncs` (partial-unique one-active + checkpoint + error class). Sync outcomes: `failed (0 chunks) | partial (some chunks) | completed`.
* Server fns `src/serverFunctions/gsc.ts` + `searchPerformance.ts` (**DB-first `hasCoverage`, else `live_fallback`** — the hybrid precedent GA4 follows).
* OAuth: hosted via `auth-config.ts` `genericOAuth` (`encryptOAuthTokens:true`, AES-GCM, `BETTER_AUTH_SECRET≥32`); self-host manual flow in `selfHostedOAuth.ts`; client kickoff `startGscLink.ts`.

### 1.5 SEO data domains (detector inputs)

* **Rank tracking:** `rank_tracking_configs`, `rank_tracking_keywords`, `rank_check_runs` (partial-unique 1-active; statuses `completed | partial | failed`), `rank_snapshots` (no FK to keywords; `position NULL`=not-found; **written incrementally per batch so partial results survive failures** — `rankCheckPaths.ts`), `rank_provider_calls`. SERP resolver dataforseo→serper→zenserp + circuit breaker. Workflows `RankCheckWorkflow` + `rankCheckPaths`; cron `scheduledRankChecks`.
* **Keywords:** `saved_keywords` (+tags), `keyword_metrics` (latest-per-key upsert). DataForSEO Labs + Google Ads providers.
* **Competitors:** `competitor_snapshots` (append-only, `canonicalKeywordKey`), `domain_overview_snapshots` (org-scoped, 7d). No dedicated route.
* **Backlinks:** `backlink_snapshots` only (summary; detail rows not persisted; synchronous snapshot writes, no background runs). R2 `backlinks` TTL 14d; snapshot freshness 24h. Ahrefs DR enrichment via KV (`ahrefs-dr:`, 24h).
* **Site audit:** `audits` (`running|completed|failed`), `audit_pages`, `audit_links` (internal-only), `audit_issues` (`critical|warning|info`), `audit_lighthouse_results` (R2 payload). `SiteAuditWorkflow` + phases (BFS, concurrency 25, KV progress 30m). Intelligence consumes **completed audits only** (failed-audit partial crawls would distort important-page joins).
* **Search performance:** `gsc_*` tables; 16-month floor; DB-first + live fallback.

### 1.6 Provider layer (extend, don't duplicate)

* `SEODataProvider {name, supports, get}` (`seo-data/types.ts`); registry `getSeoDataRouter()` (explicit list + `resetSeoDataRouter` for tests); `DataRouter` with deterministic `PROVIDER_PRIORITY`, `SeoCacheService.getOrFetch` → `singleFlight` → `traceProviderCall` → `set`; `ProviderUnavailable` → next, `BudgetExceededError` → abort. Providers: `dataforseo`, `gsc`, `google_ads`, `bing_webmaster`, `local_crawler`, `internal` (free DB reads). **GA4 is NOT a router provider** (first-party per-project OAuth, zero fallbacks, sync-oriented; forcing it in adds fake abstraction — `Ga4Service → Ga4Client` reusing cache/single-flight/trace primitives directly).
* Cache: R2 `dataforseo-cache/` + `expiresAt` (TTLs: ideas/metrics/domain 7d, serp 5d, backlinks 14d, site_audit 7d, search_console/bing 24h; `projectId` stripped for shareable keys). KV ephemeral. R2 JSON helpers `src/server/lib/r2.ts` (`putTextToR2`/`getJsonFromR2`).
* Jobs: cron `*/15` → `scheduled()` → `runScheduledRankChecks` + `runScheduledGscSync` (+ new jobs §8). No pg-boss. Long work: Cloudflare Workflows (`SITE_AUDIT_WORKFLOW`, `RANK_CHECK_WORKFLOW`; `pgStep` re-scopes ALS per step), DO agents (`SamChatAgent`, `OnboardingChatAgent`), `waitUntil` fire-and-forget.

### 1.7 MCP (24 tools — follow the pattern)

`registerOpenSeoMcpTools()` — one explicit `registerTool` per tool wrapped in `instrumentMcpToolHandler`, handler shape `withMcpProjectAuth(async (args,{auth,baseUrl,billing,project}) => Service… → mcpResponse({text, meta, structuredContent}))`, snake_case `get_*` reads, `projectIdSchema` inputs, `formatMcpTable` output. Tools: `whoami, list_projects, create_project, list_saved_keywords, research_keywords, save_keywords, get_domain_overview, get_domain_keyword_suggestions, get_backlinks_overview, get_backlinks_profile, get_serp_results, get_rank_tracker, get_ranked_keywords, search_local_businesses, get_local_serp_results, get_google_business_questions, find_serp_competitors, get_keyword_metrics, get_search_console_performance, inspect_urls, run_site_audit, get_audit_status, get_audit_issues, get_audit_pages`.

### 1.8 SAM today

`SamChatAgent extends Think` (one DO per session): soul + `memory`/`research_log` context blocks, `beforeTurn` (credit gate, trace start, effective config, adapted MCP tools minus list/create + SAM-only scrape/poll tools, `maxSteps`/`maxOutputTokens` + `toolCallCap`), bounds `DEFAULT_MAX_STEPS=48 / MAX_TOOL_CALLS=24` (`samTurnControls.ts`), GSC output bound 50 rows, streaming throttle, rewind. Memory: `sam_sessions` (registry; history in DO SQLite), `sam_project_memory` PK `(projectId,label)`, `ai_agent_settings`. Trace: ephemeral `samTraceBus` (≤500 events/turn, scrubbed). Note: `samAccess.ts` gates on `OPENROUTER_API_KEY` only — stale vs 6-provider runtime; autopilot budget checks must use `resolveSamEffectiveConfig`.

### 1.9 Observability (two systems — don't conflate)

* **Global Trace** (user Debug panel): `globalTraceTypes.ts` + `globalTraceStore.ts` + `traceServerCall.ts` wrapper + `scrubGlobalTraceText`. Safe fields only.
* **SAM trace bus** (per-turn agent debug): `samToolTraceTypes.ts` + `samTraceBus.ts` (ALS scope, router bridge `seo-data/trace.ts`).

### 1.10 Reusable UI / exports

Charts (recharts 3.7, no animation): `RankTrendChart` + `TrendRangeToggle`, `RankTrackingOverview`, `BacklinksTrendChart/NewLostChart`, `AreaTrendChart`, `BillingUsageChart`. Date ranges: selects, no calendar (`SearchPerformanceFilterToolbar`: `last_7/28_days + 3/6/12/16_months` + device/country). Filters: `RankTrackingFilters`, domain tab sorts, `LocationSelect`, `SerpLocationCombobox`, `SegmentedToggle`, table infra (`AppDataTable`, pagination, export menu). **Exports are client CSV (`csv.ts` with formula-injection guard) + Copy-to-Sheets only — no PDF, no share links exist.**

### 1.11 Docs-vs-code disagreements (do not trust docs blindly)

PRD §3.10 tool names stale (`start_site_audit`/`query_search_console_performance` vs code `run_site_audit`/`get_search_console_performance`); spec 0003 "no GSC caching" superseded by sync tables; `samAccess.ts` single-provider gate stale; "opportunities"/"autopilot"/"GA4"/"scheduled PDF reports" = zero hits in `src` (prose/preset names only).

---

## 2. Final domain definitions

Binding definitions; every downstream section references these exact terms.

* **Finding (Signal)** — deterministic observation from exactly one detector over normalized stored data. Fact only: no recommendation, no workflow status, no priority. Carries `confidenceScore` (evidence quality). **Transient**: computed per scan, frozen into the run artifact (§6), materialized into Insights/Opportunities, then discarded. Shape: `{findingKey, detectorKey, detectorVersion, projectId, entityKey, entity, evidence{metrics, periods, sources, sourceRefs, thresholdsApplied, correlations[] (overlap-only, no `causedBy` field exists), evidenceType:'observational', partialData[], confidenceInputs}, detectedAt, confidenceScore, coverageFlags}`.
* **Insight** — user-facing interpretation of ≥1 Findings for Dashboard/Reports/change summaries. `{insightKey, composerKey, severity (critical|high|medium|info), title, explanationFact, recommendation? (composer-only), evidenceSummary, entityRefs, periods, sources[], findingKeys[], opportunityIds[], contentVersion, contentHash, scanId, detectedAt, lastSeenAt, resolvedAt?}`. **No lifecycle status.** Persisted (one current row per key).
* **Opportunity** — actionable item from ≥1 Findings, with lifecycle. `{logicalKey, occurrenceNumber, type, detectorKey, detectorVersion, scoreVersion, status (open|in_progress|completed|dismissed), impactScore 0–100, confidenceScore 0–100, priority (derived critical|high|medium|low), title, explanationFact, recommendation, evidence (frozen JSON + sourceRefs), keyword?, page?, sourceMetrics, sources[], lastSeenScanId?, consecutiveMisses, stale, recurrenceOfId?, supersededById?, firstDetectedAt, lastDetectedAt, completedAt?, dismissedAt?}`. Persisted with event ledger.
* **Impact** — `impactScore 0–100` from available factors with renormalized weights (missing optional data never scores 0). Bands: Critical ≥80 / High ≥60 / Medium ≥40 / Low <40.
* **Confidence** — `confidenceScore 0–100` from evidence quality (coverage, corroboration, sample size, history, detector strength). Bands: High ≥70 / Medium ≥40 / Low <40. `FAILED` coverage blocks emission instead of producing low-confidence noise.
* **Priority** — deterministic matrix (§10): Critical+High→Critical; Critical+Med / High+High / High+Med→High; Critical+Low / High+Low / Med+High / Med+Med→Medium; else Low. **No `rankScore` column.** Canonical sort everywhere: `priority DESC, impactScore DESC, confidenceScore DESC, lastDetectedAt DESC` (single shared comparator in `src/shared/intelligence.ts`).

---

## 3. Revised target architecture

One detector truth. Two composers. All consumers read composed output.

```
DATA SOURCES — GSC · GA4 Data API · DataForSEO (SERP/Labs/Backlinks) · local crawler · Bing Webmaster · Ahrefs DR
        │
PROVIDER / ACCESS — SeoDataRouter (DataForSEO/gsc/local_crawler/internal) · Ga4Service→Ga4Client (NOT a router
        │           provider; reuses R2 cache, singleFlight, trace, error taxonomy) · SERP resolver · AI providers
NORMALIZED STORED DATA — gsc_search_performance* · ga4_daily_* + ga4_sync_coverage · rank_snapshots ·
        │                  audit_issues · backlink_snapshots · keyword_metrics · competitor_snapshots
SHARED DETECTION ENGINE (new, src/server/features/intelligence/) — deterministic pure detectors
        │
FINDINGS (transient → frozen R2 artifact per run, §6; never triple-stored)
        ├───────────────────────────┴────────────────────────────┐
        ▼                                                        ▼
InsightComposer (group + interpret)              OpportunityMaterializer (dedupe + score + lifecycle)
        │                                                        │
Dashboard Insights (persisted rows)              Opportunity lifecycle (persisted + events)
        └───────────────────────────┬────────────────────────────┘
                                    ▼
                    Reports (frozen snapshots of metrics + insight/opportunity copies)
                                    ▼
                    SAM Autopilot (reads snapshots/engine output; LLM synthesizes, never measures)
```

**Enforced by review + static test:** each SEO condition has exactly one detector under `intelligence/detectors/`. Dashboard/Reports/SAM contain zero threshold/comparison logic. Composer/materializer/synthesis modules may not import source-metric repositories (only Stage-1 detection may).

---

## 4. Detection engine architecture

Location follows repo conventions (`src/server/features/<feature>/{services,repositories}` + colocated detectors):

```
src/server/features/intelligence/
  detectors/ { types.ts (DetectorDef, DetectorContext, FindingDraft, CoverageRequirement),
               registry.ts (explicit versioned list — no auto-glob),
               lowCtrQuery.ts, contentDecay.ts, rankingDrop.ts, cannibalization.ts,
               technicalOnImportantPage.ts, organicTrafficChange.ts, ga4OrganicChange.ts,
               backlinkChange.ts, ... }
  services/ { FindingService.ts (coverage-gated detection), InsightComposer.ts,
              OpportunityMaterializer.ts, Thresholds.ts }
  repositories/ { InsightRepository.ts, OpportunityRepository.ts, ScanLedgerRepository.ts,
                  ArtifactStore.ts (R2 manifest/chunk writer/loader/validator) }
src/shared/ { intelligence.ts (Finding/Insight/Opportunity Zod contracts, key builders,
              canonicalizers, lexicographic comparator, renormalizedScore, priorityMatrix),
              intelligence-thresholds.ts, opportunity-weights.ts }
```

* **Detector contract:** `{detectorKey (stable, part of identity), version, requiredSources[], optionalCorroborators[], minConfidenceToEmit, detect(ctx, input): FindingDraft[]}` — pure, synchronous over pre-fetched inputs; thresholds injected, never hardcoded; every threshold echoed in evidence. Registry is an explicit list (mirrors `getSeoDataRouter` explicitness).
* **Finding identity:** `entityKey` canonical per family (lowercased keywords; normalized URLs via one shared helper also used by GA4 landing pages, join keys, opportunity keys; technical issues include the issue discriminator — `technical:missing_title:/product` vs `technical:canonical_mismatch:/product`; rank drops include device+market; cannibalization = sorted URL pair + query). `findingKey = sha256Hex(projectId|detectorKey|detectorVersion|entityKey|periodFrom|periodTo)`. Opportunity `logicalKey = detectorKey:entityKey` (no period — stable across scans).
* **Source gating:** `FindingService` loads the coverage map first. Required source `FAILED`/missing → detector **skipped**, recorded in `intelligence_run_detectors` (`skipped` + reason). Optional corroborator missing → run with `partialData[]` + detector-specific confidence handling (§10 table — e.g. `low_ctr_query` unaffected by GA4 absence; `content_decay` capped at Medium). `SUCCESS_ZERO_ROWS` is valid zero input; `FAILED` is never input.
* **Evidence model:** typed per detector (Zod discriminated union): metrics, periods, sources, `sourceRefs{gscFactIds?, rankSnapshotIds?, auditIssueIds?, ga4Keys?}`, `thresholdsApplied{}`, `correlations[]` (overlap-only), `evidenceType` (detectors can only emit `observational`), `partialData[]`, `confidenceInputs{}`. Detectors emit `explanationFact` only; recommendations are added exclusively by the materializer (per-`detectorKey` templates) and composer (`nextAction` links). Fact/recommendation split is structural.
* **Per-detector corroboration policies (no global penalties):**

| Detector | Required | Optional corroborators | Min coverage | Missing-corroborator behavior |
|---|---|---|---|---|
| `organic_traffic_change` / `ga4_organic_change` | GSC summary **or** GA4 summary respectively (single-source each) | the other source (raises composed insight confidence, not finding confidence) | required grain `SUCCESS_*` ≥80% of window days | no penalty |
| `low_ctr_query` | GSC query/query_page grain | none (GA4 explicitly not a corroborator) | impressions ≥ threshold, position in band, both windows covered | n/a — GA4 absence never affects it |
| `content_decay` | GSC page grain + rank corroboration **or** GA4 landing rows (either pair) | GA4 engagement; rank trend | entity present both windows with volume; truncated entities excluded | GA4 absent → confidence capped Medium; GSC+rank alone reaches High only on large sustained deltas |
| `ranking_drop` | rank snapshots (completed **or partial-with-snapshots** runs only) | GSC clicks for same entity | runs with committed snapshots both windows; failed/empty runs block | GSC absent → no penalty; agreement raises confidence |
| `cannibalization` | GSC query grain (≥2 URLs, overlapping window) or rank overlap | click-split share as strength | both URLs above impression floor | GA4 absent → no penalty; always worded "potential" |
| `technical_on_important_page` | audit issues (`critical`, latest **completed** audit) + GSC top-N page importance | GA4 landing traffic as second importance vote | completed audit + GSC coverage both required | GA4 absent → no penalty |
| `backlink_change` | ≥2 backlink snapshots within freshness window | none (MVP) | two snapshots | n/a (heuristic, labeled as such) |

---

## 5. Persistence decisions

| Layer | Persist? | Rationale |
|---|---|---|
| Raw normalized data (GSC facts, GA4 daily rows, rank snapshots, audit issues, backlink snapshots, keyword metrics, competitor snapshots) | **Yes** (existing + §14) | Source of truth for recompute, history, reports, SAM refs |
| Findings | **No relational table.** Transient scan output → **frozen R2 artifact per run** (§6) → consumed by Stages 2–3 → artifact retained 30d, then swept | Persisting findings would triple-store every condition with no independent readers; artifact gives durability without a history table |
| Insights (composed) | **Yes** (`dashboard_insights`, one current row per `insightKey`, update-in-place + resolve) | Dashboard renders without recompute; reports snapshot stable copies; SAM cites IDs |
| Opportunities + `opportunity_events` | **Yes** | Lifecycle, scoring history, audit trail, report snapshots |
| `intelligence_runs` + `intelligence_run_detectors` ledgers | **Yes** (small) | Auditability, recompute guards, provenance, resume state |
| Coverage ledgers (`ga4_sync_coverage`, GSC intervals/sync rows) | **Yes** | Zero-vs-failure distinction, confidence inputs, skip logic |
| Reports | **Yes, frozen immutable snapshots** (payload embeds metric + insight + opportunity copies) | Reproducibility; later data changes create new reports |

---

## 6. Intelligence run / stage / artifact model

No single large transaction (D1 chunks are atomic only per ≤100-statement `runBatch`). No Workflow for intelligence (cron + persisted stage state suffices; Workflows reserved for autopilot). Stage boundaries are the transaction boundaries; each stage's writes are idempotent.

```
pending → detecting → materializing → composing → completed
                                            ↘ partial (≥1 detector failed, rest ok)
any stage → failed (artifact faults, boundary-write failure, retries exhausted, unstable sources)
```

* **Stage 1 (detect):** gated by the source-consistency protocol (§7: versions equal before/after, no active mutations, bounded retries). On acceptance: canonicalize → hash → write content-addressed manifest + chunks → commit pointer + `current_stage='materializing'` in one `runBatch`. Stage 1 is single-shot per run.
* **Stage 2 (materialize):** input = parsed artifact only (+ active-opportunity rows for upsert targeting). No source-metric reads (import ban, tested).
* **Stage 3 (compose):** input = same artifact + Stage-2 materialized opportunity IDs (via run row `stage_state_json`). No source-metric reads.
* **Resume:** reload artifact by DB pointer; re-enter current stage idempotently (opportunity upserts by partial-unique + event `event_key`s; insight upserts by full unique). Crash between stages resumes at `current_stage` — never silently re-detects.

### Frozen artifact (R2, content-addressed, chunked-complete)

* Keys embed **full SHA-256** (64 hex, never truncated prefixes): `intelligence-runs/{projectId}/{runId}/manifest-{sha256}.json` + `findings-{detectorKey}-{seq:03d}-{sha256}.json` (≤1,000 findings per chunk; **no total cap — Option A, chunked complete**; manifest binds chunk hashes).
* Write protocol: canonicalize → hash → existence-check (exists+identical → reuse; exists+different → `ARTIFACT_KEY_COLLISION`, fail run) → write → verify manifest on read. R2-ok/DB-fail leaves harmless orphans (swept by 30-day unreferenced cleanup). Error classes: `ARTIFACT_HASH_MISMATCH`, `ARTIFACT_CORRUPT`, `ARTIFACT_MISSING`, `ARTIFACT_KEY_COLLISION` — all fail the run; recovery is always a new run.
* Artifact schema (`schemaVersion: 3`): `{schemaVersion, runId, projectId, inputHash, inputSourceVersions, detectorVersions, thresholdVersion, detectedAt, chunks[] {detectorKey, seq, objectKey, chunkHash, findingCount}, totalFindings, artifactHash}`.
* DB pointers on `intelligence_runs`: `manifest_key`, `manifest_hash` (full), `findings_schema_version`, `findings_count`, plus `detection_attempt_meta_json` (per-attempt before/after hashes, changed sources, active reasons).

---

## 7. Source version tokens & Detection source state

**Governing rule: versions represent the latest committed consumable data mutation — not "latest completed run".** Partial runs that finalize valid units advance the token; zero-success runs never do. Timestamps order; IDs identify (never lexical `MAX(id)`).

| Source | Valid mutation | Selection (authoritative order → token) |
|---|---|---|
| GSC | sync run finalizing ≥1 unit to `SUCCESS_WITH_DATA`/`SUCCESS_ZERO_ROWS` (`COMPLETED` or `PARTIAL`) | `ORDER BY completed_at DESC` over qualifying runs → `sync.id` |
| GA4 | same rule on `ga4_syncs` + `ga4_sync_coverage` | `ORDER BY completed_at DESC` over runs with `successful_units > 0` → run `id` |
| Rank | runs finalizing `completed` **or** `partial` with committed snapshots (verified: partial runs persist per-batch snapshots) | per config: latest qualifying run `ORDER BY completed_at DESC` → `{configId, runId, completedAt}`, canonical-sort by `configId`, token = `stableHash(array)` |
| Audit | **completed audits only** (deliberate: partial-crawl issue sets would distort important-page joins) | latest `completed` `ORDER BY completed_at DESC` → `audit.id`; running/failed feed `active` only |
| Backlinks | committed snapshot | latest `ORDER BY captured_at DESC (+id DESC tiebreak)` → `snapshot.id` |

No unified `sourceRevision` table (rejected: five indexed selector reads beat a write-amplifying coordination point).

**Active-mutation detection** (existing queries, no new tables): GSC `getActiveSyncRun` (`pending|running`); GA4 same predicate on `ga4_syncs`; rank any `pending|running` `rank_check_runs` for the project; audit any `running` audit; backlinks via in-flight `singleFlight` summary key + new snapshot id before/after.

**`DetectionSourceState`:** `{versions{gsc,ga4,rank,audit,backlinks} (ids selected above, null = unconnected/no valid mutation), sourceSet[] (sorted; connect/disconnect changes identity), detectorVersions{}, thresholdVersion, activeMutations{per-source {isMutating, activeRunIds}}}`. Accept iff active empty both sides **and** versions equal both sides **and** sourceSet equal. Accepted `inputHash = stableHash(canonicalJson({versions, sourceSet, detectorVersions, thresholdVersion}))` — active ids logged on retries, never hashed. Retries: 2 (`SOURCE_CHANGED_DURING_DETECTION` on exhaustion). Cron skips starting Detection entirely when `isMutating` pre-check trips (`deferred_active_mutation`).

---

## 8. Scheduler & recompute rules

Cron stays `*/15`; every job evaluates cheap guards before expensive work. Two independent predicates: `changed = inputHash != lastSuccessfulInputHash` **AND** `now >= nextEligibleAt`; plus a 24h safety force.

| Job | Floor (`nextEligibleAt`) | Force | Why |
|---|---|---|---|
| GSC incremental sync | existing (15-min, active-run guard) | — | No token quota; precedent stands |
| GA4 sync | **6h** per property | — | Data API per-property quotas; 4×/day bounds burn while serving traffic-drop detection |
| Intelligence scan (detect→materialize→compose) | **4h** per project even when dirty | **24h** even when clean | GSC 3-day lag, daily rank, slow audits/backlinks — sub-4h recompute rarely changes output; absorbs GSC churn |
| Reports / Autopilot | on demand (budget/credit gates) | n/a | Stored-data / user-initiated paths |

* Tick cost: one indexed ledger read per project (latest successful run: hash + timestamps) + in-memory token assembly. No metric reads unless both predicates pass.
* Manual refresh bypasses `changed`, honors **1 per 15 min per project** rate limit (`retryAfter` on excess; `triggered_by='manual'`). No automatic "critical fast path" — criticality is known only after the scan that would be duplicated.

---

## 9. GA4 architecture

### 9.1 OAuth + property mapping

`src/shared/ga4.ts`: `GA4_OAUTH_PROVIDER_ID="google-analytics"`, `GA4_OAUTH_SCOPES=["openid","email","profile","https://www.googleapis.com/auth/analytics.readonly"]` (read-only). Second `genericOAuth` entry in `auth-config.ts` (same AES-GCM envelope); `startGa4Link.ts` clones `startGscLink.ts`; `selfHostedOAuth.ts` generalized to a provider parameter (no fork). `ga4_connections` mirrors `gsc_connections` (unique `projectId`, property id/display name, connector user/account, `currency_code?`, `has_ecommerce`). Server fns `src/serverFunctions/ga4.ts` (connection set + §15 read fns). Settings gains `AnalyticsConnectionCard`. Re-consent spike required (existing GSC grants lack the new scope).

### 9.2 Client + service (NOT a router provider)

`src/server/lib/ga4Client.ts` mirrors `gscClient.ts` (`getToken` via `getAccessToken`, typed `Ga4ApiError/Ga4TokenError`, quota classification incl. `429/8 RESOURCE_EXHAUSTED` → `QUOTA_EXHAUSTED`). Methods: `listProperties()` (Admin API; capability detection), `runReport()`, `batchRunReports()` (one call per sync per property covering all grains). Dimension/metric allowlist only (see §9.4 taxonomy for stored fields). `Ga4Service → Ga4Client` reusing `SeoCacheService`/R2 (24h `ga4:*` family), `singleFlight`, `traceProviderCall`, free-call logging. Error taxonomy mirrors `classifyGscSyncError` + quota classes.

### 9.3 Storage (normalized tables, NOT one wide grain table)

| Table | Rows/day/property | Uniqueness / indexes |
|---|---|---|
| `ga4_daily_summary` | 1 | `UNIQUE(projectId,propertyId,date)`; `idx(projectId,date)` |
| `ga4_daily_acquisition` | ~10–40 (channel/source/medium) | `UNIQUE(projectId,propertyId,date,channel_group,source,medium)` + raw audit cols; `idx(projectId,date)`, `idx(projectId,channelGroup,date)` |
| `ga4_daily_landing_pages` | pages, top-N bounded | `UNIQUE(projectId,propertyId,date,landing_page)`; `idx(projectId,landingPage,date)` |
| `ga4_daily_events` | events | `UNIQUE(projectId,propertyId,date,eventName)`; `idx(projectId,eventName,date)` |
| `ga4_sync_coverage` | dates × grains (tiny) | `UNIQUE(projectId,propertyId,date,grain)`; `idx(projectId,grain,date)`; + truncation meta JSON |
| `ga4_syncs` | 1 per run | partial one-active `(projectId,propertyId) WHERE status IN ('pending','running')`; `idx(projectId,startedAt DESC)`; + `successful_units` |

Dimensions stored canonical-non-null (`'(not set)'` sentinel, `NOT NULL`) + raw nullable audit columns; uniqueness on canonical composites (identical NULL-behavior on D1/PG, no `NULLS NOT DISTINCT`). Landing-page normalization helper shared by sync, joins, and entityKey builders. Geo/tech tables deferred (same pattern when needed).

### 9.4 Metric taxonomy (binding)

Store additive components; derive ratios at query. **Never average daily rates; never sum distinct users; never mislabel.**

| Metric | Class | Stored | Period aggregation | Exact? | Period query? |
|---|---|---|---|---|---|
| `sessions`, `engagedSessions`, `userEngagementDuration` (s), `screenPageViews`, `eventCount`, `keyEvents`, revenue amounts/counts (`totalRevenue`, `purchaseRevenue`, `transactions`, `addToCarts`, `checkouts`) | additive | raw values | `SUM` | exact | no |
| `newUsers` | additive-ish, **grain-aware**: summable only across non-overlapping daily summary rows ("new on each day"); dimensioned values are dimension-level only (repository guard refuses project rollups) | daily `new_users` | `SUM` on summary grain + footnote | exact under stated definition | no |
| `engagementRate` | ratio (derived) | components only | `Σengaged/Σsessions` at query | exact | no |
| `avgEngagementTimePerSession` (correct name) | ratio (derived, denominator labeled) | components only | `Σduration/Σsessions` | exact | no |
| `averageSessionDuration` (GA4-defined) | vendor-defined | **only if fetched live; field must not exist otherwise** | as returned for exact period | exact | yes, if displayed (MVP: don't display; show engagement-time metric) |
| `totalUsers` | distinct / non-additive | daily (trend only) | never summed; exact via `getPeriodUsers` (single `runReport`, R2 `ga4:distinct-users:*` 24h), frozen into payloads with `asOf` | exact only via query | yes |
| `activeUsers` | distinct / non-additive (GA4 `activeUsers` metric — provider-faithful, no gloss) | daily (trend only) | same distinct rule | exact only via query | yes |
| `active28DayUsers` | **excluded from MVP entirely** — no column, no contract, no UI (string-level absence test) | — | — | — | — |
| per-event `users` | distinct-ish | daily per event | distinct rule at period level | approximate unless queried | only if surfaced exact |

Single-currency guard on revenue sums (mixed-currency labeled, never converted).

### 9.5 Coverage state machine (split; no unit-level PARTIAL)

* **Coverage unit (date×grain):** `PENDING → SUCCESS_WITH_DATA | SUCCESS_ZERO_ROWS | FAILED`. Partial rows from failed units persist but every consumer joins coverage and accepts only `SUCCESS_*`. Crash → stale-`PENDING` (>2h) reprocessed; idempotent upserts overwrite.
* **Sync run:** `PENDING | RUNNING | COMPLETED (all units SUCCESS_*) | PARTIAL (≥1 SUCCESS_* + ≥1 FAILED/incomplete, incl. quota-stopped) | FAILED (zero SUCCESS_* or fatal)`. Quota → halt new chunks, remainder `PENDING`, run `PARTIAL/QUOTA_EXHAUSTED`; OAuth/permission → touched units `FAILED` + reconnect guidance.
* Truncation meta on coverage/chunk rows: `{row_limit, rows_returned, is_truncated, total_rows_if_known, sampling_state, data_loss_from_other_row}`. Detector rule: absent entity in truncated grain is never zero — decay requires entity presence with volume in **both** windows; truncated windows skip or cap confidence; UI/reports badge partial datasets.
* Sync engine: `Ga4SyncService.runSync({initial (min(90d, property creation)) | incremental (from last fully-covered date) | manual})`, 7-day chunks, `limit/offset` pagination, `executeInBatches` metric+coverage upserts, checkpoint resume, concurrency guard (partial-unique + pre-check + race re-check). `runScheduledGa4Sync` in the `*/15` worker with the 6h floor; per-connection fan-out with try/catch.

### 9.6 Analytics page + joins

Route `/p/$projectId/analytics` → `AnalyticsPage` (nav item, My Site group): Overview / Acquisition (Organic highlighted) / Organic view / Landing Pages (deep-links to GSC + rank for same URL) / Events / Conversions (read-only key-event list; goal selection deferred) / conditional Ecommerce (hidden without `hasEcommerce` capability — never misleading zeros) / Audience-Tech. All sections: current vs equivalent previous period + % change + trends; DB-first with live badge; `AnalyticsFilterToolbar` (7/28/30/90d + channel/device/country). Distinct states: not-connected / no-data / partial / quota-failed / perm-failed / syncing. `AnalyticsJoinService` (normalized-URL GSC×GA4×rank join, computed at scan time, nothing persisted) powers decay/traffic-drop corroboration.

---

## 10. Opportunities Engine architecture

* **Identity:** `logicalKey = detectorKey:entityKey`, `UNIQUE(projectId, logicalKey) WHERE status IN ('open','in_progress')` (partial-unique precedent; `status NOT NULL` keeps D1/PG identical). Re-detection of active key → in-place update (score/evidence/`lastDetectedAt`, status preserved). Recurrence after terminal state → new row (`occurrence_number+1`, `recurrence_of_id`), history untouched. Detector major-version change → old row `dismissed/superseded`, new row linked (`superseded_by_id`); minor → in-place. Race safety: `INSERT … ON CONFLICT DO NOTHING` → `SELECT` → update.
* **Lifecycle:** `open → in_progress → completed | dismissed` (dismissal requires reason); every transition appends `opportunity_events`. Re-detection never reopens terminal rows. Stale: `consecutiveMisses` increments **only** on successful detector execution with the key absent (skips/failures never count — §4 policies gate this); ≥3 → `stale=1` + `stale_at` + `stale_marked` event; stale rows leave default views but stay queryable; re-detection clears (`stale_cleared`). Terminal states excluded from miss tracking.
* **Scoring (renormalized, deterministic):** impact factors `trafficPotential / proximity / decline / businessIntent / conversionSignal(optional)` each 0–1 via documented normalizers; `impactScore = round(100 × Σ(wᵢ·fᵢ)/Σ(w available))` — worked example: weights 30/25/20/15/10 with GA4 absent → divisor 90, identical score to GA4-present given same available evidence. Empty available set → no materialization (skip recorded). Confidence from coverage/completeness/corroboration/sample-size/history with per-detector weights; `partialData[]` penalties explicit. Priority matrix §2; lexicographic sort; "Why High?" panel renders factors + renormalized weights + confidence inputs + matrix cell from stored columns.
* **Content-decay confidence (capped multi-input function):** coverage, volume (floor → suppress), magnitude (saturates at 50% decline), persistence (≥2/3 windows), rank/session moves (absent → 0.5 neutral), entity consistency, truncation status, and directional **agreement capped at ≤15% contribution** — agreement alone can never reach High. All eight inputs persisted in `confidenceInputs{}`.
* **Event ledger:** `detected | redetected | rescored | evidence_updated | status_changed | stale_marked | stale_cleared | completed | dismissed | recurred | superseded`, each with `event_key = stableHash(occurrence|type|scanOrAttempt|contentHash)` + `UNIQUE(occurrence_id, event_key)` (retry-safe). Emission thresholds: `redetected` only if ≥24h since last or band change; `rescored` only on Δ≥10 / priority-band / confidence-band change; `evidence_updated` only on material content-hash change; lifecycle events always.
* **Causality:** all telemetry stamped `observational`; evidence/correlation types have no `causedBy` field. Only `provider_confirmed` / `manual_user_assertion` (future inputs) may unlock causal phrasing — MVP automated output is correlation-only ("decreased during the same period…", "consistent with…"). Enforced at schema + prompts + serializer (banned-verb gate keyed on `evidenceType`) + tests.
* **UI:** `/p/$projectId/opportunities` — filters (type/priority/status/page/keyword), sort (canonical comparator), status tabs; detail shows Evidence → history → Recommendation → related rows → **Impact / Confidence / Priority as three separate fields** with breakdown.

---

## 11. Dashboard Insights architecture

Dashboard contains **zero detector logic**. `InsightComposer` groups findings (e.g. all `ranking_drop` on top-traffic keywords → one "N important keywords lost rankings" insight with `findingKeys[]`, `opportunityIds[]`; severity = max adjusted by entity importance) into persisted rows (one current row per `insightKey`, update-in-place). `getDashboardInsights` reads stored rows + user prefs. Sections (SEO Performance / Search Visibility / Traffic & Engagement / Conversions / Opportunities top-N / Technical Health / Backlinks / Recent Changes) are grouping/filtering of stored insights; GA4-gated sections show connect-states until GA4 lands. Stale/partial banners from scan ledger (`skippedDetectors`, age thresholds); per-insight source badges + `detectedAt`; failures surfaced from coverage, never inferred.

**Insight identity & dismissal:** `insight_key = composerKey:groupKey` (site-level, keyword-set tier, or per-entity `sha8`), `UNIQUE(projectId, insight_key)`. Absent key after successful covering compose → `resolvedAt` (+reason), retained but excluded from current views; skipped-detector absence never resolves. Re-composed after resolution reopens at `content_version+1` ("reappeared after N scans clear"). `content_version` (semantic counter) + `content_hash` (integrity): per-composer material-change policy (severity change / top-5 entity Jaccard <0.5 / recommendation-class / linkage change always material; metric drift ≥25% + absolute floor; period rollover/refresh never). Non-material updates touch `lastSeenAt`/periods/evidence only. Dismissal is **per (user, project, insightKey)** (`insight_user_preferences`: `dismissed_content_version`, `snoozed_until`, hash for debugging): hidden iff `dismissed_version >= current_version` and snooze expired; version bump re-surfaces with "updated" badge. Completing an opportunity never auto-dismisses its insight.

---

## 12. Reports & agency architecture

* **Model:** `ReportService.generate({projectId, type, period})` reads metric aggregates + period insights + opportunities (by priority + completed) → validates `ReportPayload` Zod schema → inserts immutable row (`payloadSnapshotJson` + `brandingSnapshotJson`). Five types (overview / search_performance / rank_tracking / technical / executive) are section selectors over one payload shape. Generation is stored-data inline; PDF async via `waitUntil` + R2.
* **Provenance (dual-sided, never fake-exact):** every report records `{consistencyStatus: 'consistent'|'concurrent_mutation', metricSourceVersions? (only when before==after), collectionVersionsBefore?/After? (only on mutation), intelligenceRunId/Hash/SourceVersions, intelligenceStaleness, generatedAt}`. Protocol: versions-before → collect → versions-after → equal: freeze exact; mismatch: discard, retry once; still unstable: generate with `concurrent_mutation` + banner (identical string across Web/PDF/public-share/MCP) or strict-abort on flag. Stale-but-stable intelligence generates with staleness label (distinct concept from concurrent mutation).
* **Sharing:** `report_shares` (256-bit token, `sha256` hash stored, single display; `expires_at?`, `revoked_at?`, view counts) + public `r/$token` route (no shell/nav, sanitized payload incl. consistency banner, no credentials/costs). `report_events` audit (created/shared/revoked/viewed/exported_pdf, no PII).
* **Renderers:** Web and PDF renderers both consume `ReportPayload` (separate modules; print-CSS fallback regardless of Browser Rendering spike outcome).
* **Agency (split identity):** `organization_branding (organizationId UNIQUE: agencyName, agencyLogoR2Key, accentColor, footerText)` + `project_client_profiles (projectId UNIQUE CASCADE: clientName, clientLogoR2Key, reportTitleOverride?, notes?)` — dedicated table, not `projects` columns (avoids widening the hottest-joined table + parity churn). Generation freezes resolved combination into the report snapshot. Uploads validated (MIME/size/dimensions), R2 `branding/` prefix, allowlisted colors, plain-text footer. Scheduled/email delivery explicitly deferred (`report_schedules` reserved, not built).

---

## 13. SAM Autopilot architecture

* **Runtime: new `AutopilotWorkflow`** (Cloudflare Workflow — verified fit against `SiteAuditWorkflow`/`RankCheckWorkflow`: `WorkflowEntrypoint`, `withPgClient(runScoped)`, `pgStep` per durable step, instance-id identity, per-step retries). Tables `autopilot_runs` (logical runs) + `autopilot_run_attempts` (executions) + `autopilot_steps` (`UNIQUE(attempt_id, seq)` + `idx(run_id)`). SAM DO starts (`startAutopilotRun` → persist run → `WORKFLOW.create({id: runId})`), displays progress, interprets results; Workflow owns durable execution, retries (transient only), budgets (≤12 steps / ≤20 tool calls / wall-clock / per-step credit pre-check via `resolveSamEffectiveConfig`), failure recovery. New binding in `wrangler.jsonc` + `alchemy.run.ts` + `server.ts` export. No new queue system.
* **Attempt-level source pinning (one attempt = one evidence universe):** attempt captures `attemptSourceVersions` + set at creation. Each collection step dual-gates (`V_before == pin`, collect, `V_after == pin`); mismatch → discard step result, mark attempt `invalidated (SOURCE_CHANGED)`, start attempt N+1 with fresh pin (≤3 attempts/run, then `SOURCE_CHANGED_DURING_AUTOPILOT` + retry-later guidance). Steps carry `effective_source_versions_json`, `evidence_hash` (over evidence + versions), `collection_attempts`. **Synthesis consumes only frozen step evidence of the successful attempt** (no repository imports in synthesis — statically tested); summary stores `evidence_hash` binding it to the exact evidence state. Prior-attempt rows persist with `superseded_by_attempt` for debugging, excluded by predicate. Re-collection under a new pin allowed by `(attempt_id, seq)` uniqueness; collect steps never implicitly reused (`reused_from_attempt` only for declared attempt-invariant transforms); side-effecting steps governed by domain idempotency keys. Cancel terminates the current instance; resume continues the current attempt; invalidation/failure/cancel are three distinct markings. Retries visible in trace/UI (`attempt_invalidated`, `collection_retries`, PostHog `autopilot:collection_retry`).
* **Deterministic-first workflows:** `collect` steps call service functions directly (no LLM tool-calling); `correlate` steps compute overlaps deterministically; `synthesize` LLM steps receive frozen evidence + coverage flags only. Seven workflows as step-list + prompt definitions over one executor: growth plan, quick wins, traffic drop (correlation table; language-guarded), content refresh, competitor gap, technical plan, monthly review (consumes report snapshots). Output contract per recommendation: `{evidence (metrics + periods), dataSource, reasoningSummary, confidence (+why), expectedImpact (quantified only with basis, else qualitative + explanation), suggestedAction}` — no invented percentages, no causal claims (serializer-tested).
* **UI/MCP:** SAM "Autopilot" tab (picker → live step checklist via `getAutopilotRun` poll → summary cards linking opportunities/reports; cancel/resume). Server fns `start/get/list/cancel/resumeAutopilotRun`. MCP run-starters after UI proven.

---

## 14. Database schema

All changes ship both `drizzle/00XX_*.sql` + `drizzle-pg/00XX_*.sql` + dual schema files + parity coverage. Conventions: `id TEXT PK`, ISO-text timestamps, FKs `ON DELETE CASCADE` to `projects` (SET NULL only for audit pointers), `status`/enum columns `NOT NULL` (keeps partial-index semantics identical on D1/PG), `project_id`-leading indexes, JSON `TEXT`/`jsonb`, bulk writes via `executeInBatches`.

| Table | Purpose / lifecycle | Keys / indexes |
|---|---|---|
| `ga4_connections` | Property mapping; replace-on-switch; cascade | `UNIQUE(project_id)`; `idx(organization_id)` (tokens in `account`, never here) |
| `ga4_daily_summary` | 1 row/day/property; upsert; 16-mo retention | `UNIQUE(project_id,property_id,date)`; `idx(project_id,date)` |
| `ga4_daily_acquisition` | channel/source/medium/day; canonical NN dims + raw audit cols | `UNIQUE(project_id,property_id,date,channel_group,source,medium)`; `idx(project_id,date)`, `idx(project_id,channel_group,date)` |
| `ga4_daily_landing_pages` | normalized page/day, top-N bounded | `UNIQUE(project_id,property_id,date,landing_page)`; `idx(project_id,landing_page,date)` |
| `ga4_daily_events` | event/day + key flag | `UNIQUE(project_id,property_id,date,event_name)`; `idx(project_id,event_name,date)` |
| `ga4_sync_coverage` | per-(date,grain) `PENDING/SUCCESS_WITH_DATA/SUCCESS_ZERO_ROWS/FAILED` + truncation meta | `UNIQUE(project_id,property_id,date,grain)`; `idx(project_id,grain,date)` |
| `ga4_syncs` | run ledger + checkpoint + error class + `successful_units` | partial one-active `(project_id,property_id) WHERE status IN ('pending','running')`; `idx(project_id,started_at DESC)` |
| `gsc_search_performance_syncs` | ADD `successful_units` (token selection) | existing partial-unique retained |
| `intelligence_runs` | scan ledger + stage machine (`pending/detecting/materializing/composing/completed/partial/failed`) + versions/hash + manifest pointers + attempt meta + counts + error stage | `idx(project_id,started_at DESC)`; `idx(project_id,status)` |
| `intelligence_run_detectors` | per-detector outcome + counts + chunk keys | `PK(run_id, detector_key)` |
| `dashboard_insights` | current insight per key; update-in-place; resolve-not-delete; `content_version` + `content_hash` | `UNIQUE(project_id,insight_key)`; `idx(project_id,resolved_at)`; `idx(project_id,severity)`, `idx(project_id,type)` |
| `insight_user_preferences` | per-user dismiss/snooze + pinned version | `PK(user_id,project_id,insight_key)`; `idx(project_id,insight_key)` |
| `opportunities` | occurrences; impact+confidence (**no rankScore**); miss/stale counters; recurrence/supersession pointers | partial `UNIQUE(project_id,logical_key) WHERE status IN ('open','in_progress')`; `idx(project_id,status)`, `idx(project_id,type,status)`, `idx(project_id,priority,impact_score DESC)`, `idx(project_id,page)`, `idx(project_id,keyword)`, `idx(recurrence_of_id)` |
| `opportunity_events` | audit trail with idempotency keys | `UNIQUE(occurrence_id,event_key)`; `idx(occurrence_id,created_at)`; FK cascade |
| `reports` | immutable snapshots + dual-sided provenance block | `idx(project_id,created_at DESC)`; `idx(project_id,type)`; never updated when `ready` |
| `report_shares` / `report_events` | hash-only tokens; audit | `token_hash UNIQUE`; `idx(report_id)` |
| `organization_branding` | agency identity; org-upsert | `UNIQUE(organization_id)` |
| `project_client_profiles` | client identity 1:1; cascade | `UNIQUE(project_id)` |
| `autopilot_runs` | logical runs + pinned versions + evidence hash + `current_attempt_id` | `idx(project_id,status)`; `idx(project_id,started_at DESC)` |
| `autopilot_run_attempts` | executions + pins + invalidation | `UNIQUE(run_id,attempt_number)`; `idx(run_id)` |
| `autopilot_steps` | step state + frozen evidence refs | `UNIQUE(attempt_id,seq)`; `idx(run_id)` |

Dropped vs earlier drafts: wide `ga4_daily_metrics`, `agency_brandings`, `finding_scans` name, `rank_score`, `backlink_events`, `report_schedules`, any findings/history/projection tables, `active28_day_users` column.

---

## 15. API / server function plan

Same `requireProjectContext` + Zod-in-`src/types/schemas/` pattern. New/changed surface:

* `src/serverFunctions/ga4.ts` (new): `getGa4GrantStatus, getGa4Connection, listGa4Properties, setGa4Property, disconnectGa4, getAnalyticsOverview/Acquisition/LandingPages/Events/Conversions/Ecommerce/Audience, getPeriodUsers, triggerGa4Sync, getGa4SyncStatus`.
* `src/serverFunctions/intelligence.ts` (new): `triggerIntelligenceScan, getIntelligenceScanStatus` (scan→materialize→compose in guarded stages).
* `dashboard.ts` (extend): `getDashboardInsights, dismissInsight` (reads only).
* `opportunities.ts` (new): `listOpportunities, getOpportunity, updateOpportunityStatus` (scan lives in intelligence fns).
* `reports.ts` (new): `listReports, generateReport, getReport, deleteReport, createReportShare, revokeReportShare, getReportShares, exportReportPdf`.
* `autopilot.ts` (new): `startAutopilotRun, getAutopilotRun, listAutopilotRuns, cancelAutopilotRun, resumeAutopilotRun`.
* Public (sole unauthenticated surface): `r/$token` loader + `getPublicReport` (token-hash lookup only).
* Internal-only: `FindingService`, `InsightComposer`, `OpportunityMaterializer`, `AnalyticsJoinService`, `Ga4Service/Ga4SyncService`, `AutopilotWorkflow` step handlers, `ArtifactStore`, canonical/token/selector helpers.

---

## 16. MCP plan

Conventions unchanged (`registerTool` + `withMcpProjectAuth` + `instrumentMcpToolHandler`, snake_case, GSC-style 50-row agent bounding on analytics tools). Required MVP: `get_analytics_overview`, `get_analytics_landing_pages`, `list_opportunities`, `get_opportunity`, `update_opportunity_status`, `get_dashboard_insights`, `generate_report`, `get_report`. Optional after UI proven: `get_analytics_events`, `list_reports`, `get_autopilot_run`, `run_seo_growth_plan` (returns run id; polling via `get_autopilot_run`). No detector logic in handlers; tools read engine-backed services.

---

## 17. UI / route plan

| Route | Content |
|---|---|
| `/p/$projectId/analytics` (new) | `AnalyticsPage` + sections §9.6; `AnalyticsFilterToolbar`; coverage-driven states; nav item |
| `/p/$projectId/opportunities` (new) | List + detail ($reportId-style drawer/page); Evidence/History/Recommendation split; Impact/Confidence/Priority + "why" breakdown |
| `/p/$projectId/reports` + `$reportId` (new) | Generate modal (type/period), snapshot detail, share modal, PDF button, branding preview |
| `/r/$token` (new, outside `_project`) | Public read-only report incl. consistency banner; no shell/nav |
| Dashboard (extend) | Composed insight sections; shared `EvidenceBlock`/`RecommendationBlock`, `ScoreBreakdown`, `StaleBanner`, `SourceBadge`; GA4-gated placeholders pre-GA4 |
| SAM (extend) | Autopilot tab: picker → step checklist → summary cards → cancel/resume; attempt/retry visibility |
| Settings (extend) | GA4 connect card; org branding + per-project client profile editors |

Shared primitives: `EvidenceBlock`/`RecommendationBlock` (reused by insights, opportunities, autopilot summaries), `ScoreBreakdown`, `StaleBanner`, `SourceBadge`, distinct `EmptyState` variants (loading / empty / not-connected / no-data / partial / stale / API-failure / permission-failure / sync-running / sync-failed — never collapsed).

---

## 18. Observability plan

* Global Trace (`traceServerCall`, existing scrubbers — never tokens/PII/raw dumps): features `ga4` (sync/overview/landing/period-users), `intelligence` (scan/detect/compose/materialize + per-detector children: rows read, findings, skips + reasons + attempt hashes), `opportunities` (status_change), `reports` (generate/share/export_pdf + consistency status), `autopilot` (run_start/step_*/attempt_invalidated). Artifact ops traced (`artifact.write {sizeBytes, chunks, hash8}`, `artifact.load {verified}`); Detection attempts traced (`H_before8/H_after8`, changed sources, active reasons).
* SAM trace bus: existing vocabulary covers autopilot synthesis steps via the router-bridge pattern; no schema change.
* PostHog via `waitUntil`: `ga4:{connect,sync}`, `intelligence:{scan,detection_retry,detection_unstable,artifact_corrupt}`, `opportunity:{materialize,status_change}`, `report:{generate,share,revoke,export_pdf}`, `autopilot:{start,complete,fail,collection_retry}`.
* Cron logs `[cron:ga4]`, `[cron:intelligence]` mirroring `[cron:gsc]`.

---

## 19. Testing matrix

Per phase (unit colocated + integration + repository/parity + service auth-scoping + UI states + E2E critical flows), plus the binding cases:

* Detector fixtures (every detector): sufficient-data positives; insufficient-data negatives (CTR ignores low impressions; ranking-drop ignores failed runs; decay ignores partial windows; cannibalization asserts "potential"; zero-rows valid vs API-error failure — separate tests).
* Scoring: fixed inputs → fixed scores; missing-GA4 renormalization identity (missing ≠ zero); empty-factor set → skip; "why" breakdown sums to score.
* Identity/lifecycle: terminal→recurrence coexistence; concurrent double-materialization → one active row; major-version supersede vs minor in-place; insight upsert-by-key (no duplicates), resolve/reopen version rule; per-user dismissal isolation; contentVersion matrix (noise stays, severity/metric-threshold bumps, v4 re-surfaces over v3 dismissal).
* Consistency: same-date correction → new token + new hash; rapid changes bounded by 4h floor; manual rate limit; resume-after-materialize with zero duplicate events; artifact round-trip/hash-verify/collision/missing/corrupt paths; crash-before-materialize resumes from identical frozen bytes despite mutated sources; Detection mid-sync discard + exhaustion error; report stable→exact / unstable→dual-sided + identical banner across renderers; autopilot step-collision → invalidation → new attempt, synthesis-membership assertion, `(attempt_id,seq)` recollection, side-effect dedupe.
* GA4 math: Σ-ratio aggregation fixtures; no `SUM(users)` (static + behavioral); exact-via-query freeze; duration-label assertions (derived value never labeled `averageSessionDuration`); `active28DayUsers` absence (schema + contract + copy); summary-`newUsers` sum allowed, dimensioned sum refused.
* Coverage: partial-write never SUCCESS; failed-unit rows excluded downstream; retry-to-SUCCESS; run PARTIAL/COMPLETED/FAILED matrix; zero-row validity; non-success never zero.
* Snapshots/tokens: report immutability under source mutation; share-token lifecycle; parity tests extended; wrong-org `projectId` → `NOT_FOUND` on every new fn.
* Causality: observational fixtures contain zero banned causal verbs across all workflow outputs; only non-observational evidence classes unlock causal phrasing.
* No-duplicate-logic: static test forbidding detector/threshold imports outside `intelligence/` (+ synthesis/composer import bans on source-metric repos); registry uniqueness (one `detectorKey` per condition).
* E2E: GA4 connect (mocked) → analytics renders; opportunity status round-trip; share-link view; growth-plan run → summary with linked entities.

---

## 20. Dependency graph

```
B0 GA4 OAuth/connection → B1 client+service → B2 storage+coverage+sync ─┬→ B3 analytics page → events/ecommerce/audience
                                                                        └→ GA4-gated findings (needs I0 too)
I0 intelligence-core (contracts/registry/tokens/artifact/stages) → F1 shared detectors (non-GA4)
F1 → OM materialization (model/lifecycle/scoring/events) → OU opportunities UI
F1 + OM → IC insight composer (+ dismissal/versioning) → DU dashboard UI
B2 + OM + IC → R0 report snapshots (+ dual provenance) → R1 renderers → R2 sharing+agency → R3 PDF
OM + IC + R0 → AP0 AutopilotWorkflow + attempts → AP1 workflows 1–3 → AP2 UI/MCP → AP3 workflows 4–7
```

Hard gates: I0 before any detector/materializer/composer; B2 before GA4-gated findings/B3/joins; OM before IC/OU/R0/AP0. Parallelizable: B-lane vs I0/OM-skeleton vs agency tables (independent); B3 UI vs F1 detectors; R3 vendor spike anytime after R0 frozen.

---

## 21. PR breakdown

Small, reviewable; each with dual-dialect migration + parity + scoped tests. Only the listed deltas from all prior passes are incorporated (no other scope).

| # | PR | Objective / major files | Deps | Key acceptance |
|---|---|---|---|---|
| 1 | `ga4-oauth-connections` | Scopes, grants, property mapping, connect UI. `src/shared/ga4.ts`, `auth-config.ts`, generalized `selfHostedOAuth.ts`, `ga4.schema.ts`+pg (`ga4_connections`), `serverFunctions/ga4.ts` (conn fns), `startGa4Link.ts`, `AnalyticsConnectionCard`, settings | — | Connect/list/set/disconnect hosted + self-host; encrypted tokens; wrong-org rejected; re-consent spike done |
| 2 | `ga4-client-service` | Data API client + `Ga4Service` (no router) + cache/trace reuse. `ga4Client.ts`, `Ga4Service.ts`, `ga4:*` TTL family, error taxonomy | PR1 | Allowlisted dims/metrics; quota classification; R2 hit/miss; scrubbed traces |
| 3 | `ga4-storage-coverage-sync` | Normalized tables + canonical NN dims + coverage machine (§9.5) + truncation meta + ordered writes + crash recovery + additive-only storage + `getPeriodUsers` + grain-aware `newUsers` helpers + `successful_units`. Sync engine + 6h cron guard + status UI | PR2 | Partial-write never SUCCESS; PARTIAL/COMPLETED/FAILED matrix; zero-vs-failure; no `SUM(users)`; `active28DayUsers` absent; stale-PENDING recovery |
| 4 | `analytics-page-mvp` | Overview/acquisition/organic/landing + filters + nav. `analytics.tsx`, `features/analytics/*`, `items.ts` | PR3 | DB-first + live badge; Δ + trends; all UX states distinct |
| 5 | `analytics-events-ecommerce-audience` | Events, read-only conversions, conditional ecommerce, audience + capability flags | PR4 | Ecommerce hidden without data; key-event list |
| 6 | `intelligence-core` | Contracts, detector interface, versioned registry, thresholds/weights, staged `intelligence_runs` + `intelligence_run_detectors`, version-token selectors (timestamp-ordered, rank per-config set), consistency-gated Detection, content-addressed chunked artifact (v3, full digests) + 4 error classes, canonical helpers, import-ban test harness | — | Hash-stability; resume-without-redetect; no truncated keys; no lexical ordering; orphan-safe |
| 7 | `finding-detectors-core` | Shared detectors (traffic-change, low-CTR, decay non-GA4 path, ranking-drop, cannibalization, tech-on-important-page, backlink-change) + coverage gating + per-detector corroboration policies | PR6 (+ existing repos) | All fixture negatives; skip-on-FAILED; findings transient + keyed |
| 8 | `opportunity-materialization` | Model + partial-active uniqueness + recurrence/supersession + lifecycle/events (threshold-gated, idempotent) + renormalization scoring + impact/confidence/priority (no rankScore) + decay confidence function + observational causality lock | PR6–7 | Dedupe/recurrence/supersede; renormalization identity; matrix cells; lifecycle preservation |
| 9 | `opportunities-ui` | List/detail/filters/status/score breakdown; three-field Impact/Confidence/Priority display | PR8 | Filter round-trip; drill-down; explainability panel |
| 10 | `finding-detectors-ga4` | GA4-gated findings + `AnalyticsJoinService` + confidence caps + join coverage gates | PR3 + PR6–7 | Absent-GA4 degradation; join correctness |
| 11 | `dashboard-insight-composer` | `InsightComposer` + identity/versioning + user prefs + hash-invalidation + staged compose + watermark-gated scheduler + dashboard UI recomposition | PR7–8 (+PR10) | Grouping rules; skip guards; no duplicate currents; versioned re-surface |
| 12 | `reports-core` | Snapshot model + 5 section-selectors + dual-sided provenance + list/detail + generate | PR8 + PR11 (+PR3) | Immutability; exact-or-dual-sided provenance; banner parity |
| 13 | `report-sharing-agency` | Share tokens + public route + split branding (`organization_branding` + `project_client_profiles`) | PR12 | Token lifecycle; leak audit; agency+client render |
| 14 | `report-pdf` | Decoupled PDF renderer + async export + R2 | PR12 (+ vendor spike) | Payload fidelity; async status; print-CSS fallback |
| 15 | `autopilot-workflow` | Workflow + bindings + runs/attempts/steps (attempt-scoped unique) + attempt pinning + dual-gate steps + bounded invalidation retries + budgets + cancel/resume/invalidate trichotomy + reconciler + traces | PR8 + PR11 | Resume idempotency; mixed-version synthesis impossible; orphan reconciliation |
| 16 | `autopilot-workflows-1-3` | Growth plan, quick wins, traffic drop + `evidenceType` serializer (observational default) | PR15 (+PR10) | Causal-verb bans; evidence+confidence present |
| 17 | `intelligence-mcp-ui` | SAM autopilot tab + step polling + MCP read tools (+ run-starters after proven) | PR4, PR9, PR12–13, PR16 | E2E run→summary→linked entities; single code path SAM/UI/MCP |

---

## 22. MVP vs later enhancements

**MVP:** PRs 1–9 + 11–13 + 15–16, MCP read tools, causal serializer, coverage ledgers, watermark guards, all invariant tests. **Deferred:** custom GA4 ranges; in-app goal selection; `ga4_daily_geo/technology`; detectors 6–11 (competitor gap, internal links, technical expansion, lost-backlink history, GA4 conversion, engagement); per-project threshold/weight overrides; `report_schedules` + email; PDF hardening; workflows 4–7; autopilot MCP run-starters; insight snooze extensions; `finding_samples` analytics (only if detector-precision work demands it); partial-audit intelligence (new detector family, not a token reinterpretation).

---

## 23. Risks / open questions

Only genuine items, each with owning spike (no invented blockers):

1. **GA4 live calibration** (PR3): chunk size, landing-page top-N, 6h cadence, `(other)`-row prevalence, `samplingMetadatas` shape — measure against a real property; ship behind config.
2. **Backlink snapshot sufficiency** (PR7): two-point diffs ship as labeled heuristic; history-based promotion deferred pending observed noise.
3. **`samAccess.ts` staleness** (PR15): single-provider gate vs six-provider runtime — autopilot budgets use `resolveSamEffectiveConfig`; fix-or-bypass inside PR15.
4. **PDF vendor on Workers** (PR14): Browser Rendering per deploy path unconfirmed; print-CSS floor guaranteed.
5. **Threshold initialization** (PR7/PR8): default bands are reasoned priors — log near-miss distributions from first production scans to calibrate without code-path changes.

---

## 24. Recommended execution order

```
PR1 ga4-oauth-connections + PR6 intelligence-core   ← start in parallel (disjoint files/tables; joined only by frozen contracts)
PR2 ga4-client-service  (after PR1)                   PR7 finding-detectors-core (after PR6)
PR3 ga4-storage-coverage-sync (after PR2)             PR8 opportunity-materialization (after PR6–7)
PR4 analytics-page-mvp → PR5 events/ecommerce         PR9 opportunities-ui (after PR8)
PR10 finding-detectors-ga4 (after PR3 + PR6–7)
PR11 dashboard-insight-composer (after PR7–8 [+PR10])
PR12 reports-core → PR13 sharing+agency → PR14 PDF (after PR8 + PR11 [+PR3])
PR15 autopilot-workflow → PR16 workflows 1–3 → PR17 MCP + SAM UI (after PR8 + PR11)
```

**Why this order:** GA4 storage+coverage must exist before any GA4-gated finding, report section, or join has valid inputs. The shared framework (PR6) must precede all detectors or duplication re-enters. Materialization (PR8) must precede composer (PR11) and reports (PR12) because both consume opportunity identity and scores — composing or snapshotting before identity/scoring is stable bakes instability into persisted rows. Autopilot comes last because durable orchestration is only meaningful over deterministic, citable engine output.

---

*End of consolidated plan. All six passes locked above. Implementation begins with PR1 + PR6 per §24.*
