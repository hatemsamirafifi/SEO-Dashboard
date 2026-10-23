# P1 — SEO Intelligence & Smart Crawler Implementation Master Plan

**Status:** APPROVED FOR EXECUTION (decisions locked 2026-10-17; pre-implementation revision 2026-10-19 — third-source `salla-crawler` assessment added, URL discovery / quality metrics / Salla adapter scope expanded, Salla-specific verification gates added. All nine phases, locked decisions, architecture constraints, and acceptance gates preserved.)
**Priority:** P1 — High Priority
**Baseline branch:** `feat/speckit-wave3-impl` @ `809f142` (`feat(autopilot): complete SAM operations and workflow integration`)
**Reference repo:** https://github.com/hatemsamirafifi/SEO-Dashboard (this fork, git remote `origin`)
**Upstream reference (fetch-only, never merged):** https://github.com/every-app/open-seo (git remote `upstream`)
**Third reference (analysis-only, never imported):** `F:\Salla Store Crawler\salla-crawler` (unpacked `salla-crawler.zip`) — standalone Python/FastAPI/Celery/Redis Salla crawl platform. Assessed at code level (§2.5) for portable algorithms only. It never enters the repo: no vendoring, no translation of its backend/queue/database stack, no copying of its `.env` (which contains live-looking credentials — never commit).
**Mode:** Audit → Design → Implement → Test → Verify → Report

AI Citation Source Gaps — Mission --------------------------

Enhance OpenSEO through nine coordinated phases executed in strict order:

1. Crawler Assessment & Hardening (first, mandatory)
2. Salla-Compatible Smart Crawler
3. Access Handling, Crawl Reliability & Cloudflare Constraints
4. Schema Markup Generator & Intelligence
5. Internal Linking Opportunities Engine
6. Keyword Cannibalization Detector (extend, don't rebuild)
7. SERP-Based Keyword Clustering
8. AI Citation Source Gaps
9. Unified SEO Next Actions Engine

No feature phase starts until the crawler milestone (Phases 1–3) passes its acceptance gate.

---

# 1. Locked Decisions (2026-10-17)

## 1.1 Upstream — Fetch + Selective Review Only

- Do **NOT** merge or rebase `upstream/main` at any point during this implementation wave.
- Preserve all 169 fork-specific commits (Speckit Waves, Intelligence Engine, SAM Autopilot, custom integrations).
- Record branch, HEAD commit, and working-tree status before any change.
- `git fetch upstream --tags` is authorized (writes .git objects/refs only).
- Review upstream releases **v0.1.9 → v0.1.13**, focusing on: JavaScript Rendering, Bot Challenge Detection, Shopify/Crawler Access handling, URL Discovery, Sitemap Processing, Crawl Reliability, Cloudflare Workers compatibility.
- Classify each relevant upstream change: `ALREADY IMPLEMENTED | IMPLEMENTED DIFFERENTLY | MISSING AND USEFUL | NOT APPLICABLE | CONFLICTING WITH FORK ARCHITECTURE`.
- Adapt small useful changes to the fork's architecture; cherry-pick only after dependency/scope/test-impact verification with focused regression tests after each port.
- Never import unrelated upstream UI/database/agent/provider changes.

## 1.2 Branching — Per-Phase Branches, Isolated Worktrees

- `feat/speckit-wave3-impl` remains the integration baseline.
- **spec-014 protection:** ~40 uncommitted modified files from competitor-gap work must not be committed, stashed, discarded, reset, or overwritten. Inspect and document the status; preserve in the original worktree.
- Every phase runs in an isolated git worktree created from the current committed HEAD:

| Branch                      | Scope                                          |
| --------------------------- | ---------------------------------------------- |
| `feat/p1-crawler-hardening` | Phases 1–3 (first cohesive delivery milestone) |
| `feat/p1-schema-generator`  | Phase 4                                        |
| `feat/p1-internal-linking`  | Phase 5                                        |
| `feat/p1-cannibalization`   | Phase 6                                        |
| `feat/p1-serp-clustering`   | Phase 7                                        |
| `feat/p1-ai-citation-gaps`  | Phase 8                                        |
| `feat/p1-next-actions`      | Phase 9                                        |

- Merge completed phases into the integration baseline only after per-phase acceptance gates pass, from a clean integration worktree.
- Each dependent phase branches from the latest verified integration baseline.
- Never force-push or rewrite shared branch history.

## 1.3 JavaScript Rendering — Heuristic-Only, Future-Ready Architecture

Static-first for Phases 1–3. No Cloudflare Browser Rendering binding or paid rendering infrastructure in this wave.

- Build a pluggable `PageRenderer` interface without implementing a paid backend.
- Evidence-based rendering-requirement detection (never classify render-needed just because a page has `<script>` or little text).
- Explicit per-page extraction states:

```
STATIC_COMPLETE | STATIC_PARTIAL | RENDERING_REQUIRED | ACCESS_BLOCKED | EXTRACTION_FAILED
```

- Persist extraction method, completeness, confidence, and diagnostic reasons.
- **Never emit confirmed missing-title / missing-content / missing-schema / missing-link findings for pages whose extraction is incomplete.** Report uncertainty instead.
- UI indicators: Rendering required · Partial SEO analysis · JavaScript content unavailable · Access blocked · Static analysis complete.
- Preserve SSRF protection, project isolation, cancellation, provider budgets, retry controls.

**Correction noted:** Cloudflare Browser Rendering is available on both Free and Paid Workers plans subject to different limits. Verify current official pricing, concurrency, and session-timeout docs before any future pilot decision.

**Mandatory evaluation gate (before Phase 4):** test static + CSR fixtures (and authorized live Salla stores where available); report static extraction coverage, URLs requiring rendering, inaccessible/blocked pages separately; identify which Schema/Internal-Linking analyses cannot run reliably without rendering; recommend a limited Browser Rendering pilot only if coverage materially undermines downstream accuracy. Never claim full Salla compatibility when CSR content is unavailable.

## 1.4 SERP Clustering — Persist Top-10 Organic URLs From Existing Rank Checks

- Extend the rank-tracking SERP pipeline to persist the top-10 organic URLs already returned by successful provider calls. **No new paid SERP requests.**
- Persist: keyword, engine, location, language, device, provider, observation timestamp, organic position, result URL, normalized URL, associated rank-check execution ID, collection/completeness status.
- Persist only validated organic results (exclude ads/non-organic features from overlap math).
- Safe URL normalization without collapsing distinct pages or meaningful query params.
- Dedup + retention policies; never store full SERP HTML.

**Rank-tracking protection invariants (hard gates):** provider errors remain CHECK_FAILED; DataForSEO `40201` stays permanent/non-retryable; `NO_RESULT` semantics preserved; failed provider requests never produce successful snapshots; missing data ≠ zero overlap; historical rankings untouched when checks fail; a snapshot-persistence failure is reported independently and never silently corrupts a valid rank result.

**Clustering eligibility:** matching engine/location/language/device/comparable observation window/sufficient organic results. Configurable overlap threshold, initial hypothesis 3 shared URLs among top-10. Anti-mega-cluster bridge guards.

**Coverage states:** READY · AWAITING_SERP_DATA · INSUFFICIENT_DATA · STALE_DATA · CLUSTERED. Surface snapshot coverage, freshness, and coverage %; describe clustering as forward-looking. Design collection so an opt-in paid backfill can slot in later (out of scope now).

## 1.5 Salla — Public Crawler First; OAuth Connector Mock-Tested Only

- Detection + sitemap discovery + static crawling + product/category extraction are independent of the API connector.
- OAuth connector (Salla Merchant API, least-privilege scopes incl. `products.read` where applicable) implemented behind a feature flag, **disabled until valid app credentials + owner-authorized test store exist**.
- Salla docs verified at implementation time against current official documentation (endpoints, scopes, token lifecycle).
- Mock-tested: authorize flow, secure token exchange/storage (AES-GCM, mirroring existing provider credential crypto), refresh/revocation, product/category retrieval, pagination, error/rate-limit handling, project/store ownership boundaries.
- No credentials in source; no tokens in logs, responses, or Global Debug Trace.
- API-derived catalog records are never treated as proof that a public product URL is crawlable/indexable/SEO-correct; clearly separate API data from verified rendered-page data.

## 1.6 Third Source — `salla-crawler` (Analysis-Only Reference)

- The supplied `salla-crawler.zip` (unpacked at `F:\Salla Store Crawler\salla-crawler`) is assessed alongside the OpenSEO fork and the upstream reference. Full code-level findings in §2.5.
- **Never import its architecture:** no Python/FastAPI backend, no Redis/Celery queue, no Playwright/Chromium worker model, no separate PostgreSQL schema, no Docker/Nginx stack, no standalone React SPA. OpenSEO's Cloudflare Workflows crawler, TanStack server-function architecture, and dual-dialect drizzle schema remain the only crawler substrate.
- **Portable algorithms only:** stock-availability evidence ladder (incl. Arabic keyword signals and explicit `UNKNOWN` default), Salla URL-pattern heuristics (product/category), JSON-LD-first product extraction with HTML fallback merge, category→product listing link harvesting, redirect-chain capture, retry classification (429/5xx retry, 404/410 no-retry), pause/resume queue semantics, crawl counter model. Each is re-implemented in TypeScript inside the existing audit lib, adapted to the fork's evidence/confidence model — never lifted as code.
- **Defects to not replicate** (catalogued in §2.5): TLS verification disabled, browser-UA impersonation, query-string-blind URL policy, first-non-empty-hit sitemap discovery, in-memory-only dedup, fabricated defaults (`currency: "SAR"`, binary InStock/OutOfStock coercion, `out_of_stock` guess on unrecognized stock elements), swallowed parse errors counted as completed pages, cancelled URLs marked FAILED.
- Every ported heuristic lands behind evidence tracking: extraction records _which_ signal produced a value; unknown values stay null/`UNKNOWN`. No value is ever manufactured.

---

# 2. Phase 0 Repository Assessment — Completed Findings

Checkout: branch `feat/speckit-wave3-impl`, HEAD `809f142`, ~40 uncommitted spec-014 files, 127 commits behind `upstream/main` (tags v0.1.9–v0.1.13 exist upstream), 169 commits ahead. Local release notes stop at v0.1.3.

## 2.1 Crawler / Site Audit (exists, will be hardened — NOT rebuilt)

- Server functions `src/serverFunctions/audit.ts` (`startAudit`, `getAuditStatus`, `getAuditResults`, `getAuditHistory`, `getCrawlProgress`, `deleteAudit`) → `AuditService` (`src/server/features/audit/services/AuditService.ts`) → `SiteAuditWorkflow` (`src/server/workflows/SiteAuditWorkflow.ts`).
- Cloudflare **Workflows**-based with durable batch steps (`pgStep.ts`), 25-concurrent crawl batches (`siteAuditWorkflowCrawl.ts`), idempotent persistence via deterministic row IDs (`src/server/lib/audit/ids.ts`).
- Discovery `src/server/lib/audit/discovery.ts`: robots.txt parsing (`robots-parser`), sitemap + **sitemap-index recursion (depth 3, 300 docs)**, fast-xml-parser, same-origin scoping.
- Normalization/scoping `src/server/lib/audit/url-utils.ts` (+ `isSameOrigin` www/apex handling), policy guard `src/server/lib/audit/url-policy.ts` (`isCrawlableUrl`, `normalizeAndValidateStartUrl`, DoH resolution check for start URLs, `CRAWL_TARGET_BLOCKED`), plus wrangler `global_fetch_strictly_public` backstop and `src/server/lib/seo-data/providers/ssrf-guard.ts`.
- Blocked detection in `site-audit-workflow-helpers.ts` (`classifyFetch`): `cf-mitigated` header, 401/403/429, Cloudflare challenge body markers on 503; challenge HTML never parsed as real content; `fetch_class` persisted per page.
- Parsing `src/server/lib/audit/page-analyzer.ts` (cheerio): title/meta/canonical/robots/OG/headings/word count/images(+alt)/links(internal+external, deduped)/JSON-LD **presence boolean only**/hreflang.
- Issues: registry `src/shared/audit-issues.ts` (27 descriptors with how-to-fix); per-page reporters `src/server/lib/audit/issues/page-reporters.ts`; cross-page `multipage.ts` + `multipage-checks.ts` (broken-internal-link, orphan, duplicate-title/desc/content, redirect chains/loops, deep-page).
- Persistence (dual schema `src/db/audit.schema.ts` / `src/db/pg/audit.schema.ts`): `audits`, `audit_pages`, `audit_links` (**internal edges only, 500/page cap**), `audit_issues`, `audit_lighthouse_results` (payloads to R2).
- MCP/SAM: `src/server/mcp/tools/site-audit-tools.ts` (run/get status/issues/pages), SAM polling via `samLongRunningTools.ts`; `technical_on_important_page` detector consumes audit issues.
- **Test harness:** `badseo/` fixture site + `badseo/scripts/run-audit.ts` asserting each fixture triggers its declared issue types (includes a 403-blocked page and trailing-slash redirect trap).

**Confirmed gaps:** no JS rendering; single-attempt 15s fetch (no per-page retry/backoff, no per-host rate limit: 25-wide against one origin); no charset handling beyond default; challenge detection misses 200-served interstitials and non-Cloudflare vendors; fetch errors produce no issue row; `has_structured_data` boolean only (no JSON-LD parsing); external link edge rows not stored; no platform detection; no graceful cancellation (delete-only); no queued/blocked/failed/skipped status counts; frontier caps (`MAX_FRONTIER_LINKS_PER_BATCH`=2000, seed 768KiB) need review under larger crawls.

## 2.2 Intelligence / Opportunities Engine (exists — extend, don't duplicate)

- 13 registered detectors (`src/server/features/intelligence/detectors/registry.ts`) **including an existing `cannibalization` detector** (`GSC query_page` grain + rank-snapshot corroboration, coverage-ratio gated, "potential" wording; thresholds in `src/shared/intelligence-thresholds.ts`).
- Materialization with stable dedup: `materializeFinding.ts` — `logicalKey` = `detectorKey:entityKey`, content-hash event keys, partial unique index `opportunities_active_key_uidx`, supersession/recurrence chains, 4-state lifecycle (`open|in_progress|completed|dismissed`), R2-frozen evidence.
- Scoring: `OPPORTUNITY_WEIGHTS` (traffic 30 / proximity 25 / decline 20 / businessIntent 15 / conversion 10), impact bands, deterministic priority matrix, template-only recommendations.
- SAM autopilot consumes stored opportunities read-only (`collectEngineState`) with pins, attempts, budgets, cancellation/resume.
- No "next actions" entity, no assignee/owner/effort columns, no citation persistence, no internal-linking detector.

## 2.3 Data Availability (decisive for Phases 6–8)

- **GSC:** `gsc_search_performance` stores per-date `query_page` grain facts (clicks/impressions/ctr/position) — offline cannibalization data exists. Sync ledger + conservative coverage (`gscWindows.ts`), `dataState:"all"` includes pre-final days, `GSC_DATA_LAG_DAYS=3` heuristic understood.
- **SERP:** `rank_snapshots` stores only the target domain's URL; full organic lists are fetched then discarded; frozen `SerpSnapshot` contract in `src/server/features/serp/types.ts` has **no table/writer**; R2 SERP cache is hash-keyed, non-enumerable. → Phase 7 needs the new persistence table.
- **AI visibility:** stateless. Prompt Explorer caches raw answer text + extracted citations in R2 (7-day TTL, brand-agnostic); Brand Lookup keeps 24h aggregates; **zero DB tables**. `extractCitations` + `matchedBrand`/`brandMentioned` distinction already exist (`src/server/features/ai-search/services/promptExplorer.ts`).
- **Keywords:** `keyword_metrics` (.latest per project+keyword+market), `saved_keywords`, competitor/domain snapshots offline-readable.

## 2.4 Infrastructure Constraints

- Dual dialect: SQLite (`src/db/*.schema.ts`) is generated-from source of truth; **PG mirrors are hand-maintained** and guarded by `src/db/schema-parity.test.ts`. Every schema change = 4 artifacts (schema file ×2 + migrations ×2 via `pnpm db:generate:d1` / `pnpm db:generate:pg`).
- Architecture rule (AGENTS.md): server function → service → repository; TanStack file routes under `src/routes/`; Zod validators at boundaries.
- Tests: 299 co-located vitest files; per-test in-memory libsql + real migration SQL; 10 Playwright specs; `badseo` fixture package included in `ci:check` (`tsc --noEmit -p badseo/tsconfig.json`).
- Commands: `pnpm test:ci`, `pnpm ci:check` (prettier + knip + tsc ×2 + oxlint), `pnpm db:generate`, schema-parity test, `pnpm build`, `pnpm test:e2e`.
- Specs convention: `specs/014-competitor-gap-conditional` is latest → new phases use specs 015–021 (confirmed available; will confirm against repo before use).

## 2.5 Third-Source Assessment — `salla-crawler` (code-level gap analysis)

Source reviewed: `F:\Salla Store Crawler\salla-crawler` — Python 3, FastAPI + SQLAlchemy + Alembic backend, Celery/Redis workers, PostgreSQL, Playwright (all-or-nothing JS render per crawl), React SPA, Docker/Nginx. Purpose-built "Screaming Frog for Salla" per `plan.md`. Reviewed files: `crawler/engine.py`, `crawler/http_client.py`, `crawler/discovery.py`, `crawler/url_queue.py`, `crawler/tasks.py`, `salla_parser/parser.py`, `backend/app/models/models.py`, `backend/app/api/*`, `database/init.sql`, `reports/*`, frontend.

### 2.5.1 Reusable algorithms → port as TypeScript inside `src/server/lib/audit/`

| #   | Algorithm (source)                                                                                                                                                                                                                                                           | Assessment                                                                                                                                                         | OpenSEO destination                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| R1  | Stock-availability evidence ladder (`parser.py::_parse_stock`) — OG `product:availability` meta → `itemprop=availability` link/meta → `data-stock` attr → stock-class keywords (incl. Arabic: متوفر/غير متوفر/نفد) → add-to-cart disabled state → explicit `UNKNOWN` default | **Reusable.** Multi-signal ladder with honest UNKNOWN matches our evidence model. Port the signal ordering + bilingual keyword sets.                               | `salla/product-extractor.ts` (Phase 2) |
| R2  | JSON-LD-first product extraction with per-field HTML fallback merge (`parser.py::_parse_product`): LD+JSON wins per-field; HTML selectors fill only nulls                                                                                                                    | **Reusable as merge policy.** Aligns with Phase 1 JSON-LD parsing; per-field precedence + evidence provenance added.                                               | `salla/product-extractor.ts`           |
| R3  | Salla URL-pattern heuristics (`PRODUCT_URL_PATTERNS`, `CATEGORY_URL_PATTERNS`: `/product/`, `/products/`, `/item/`, `/category/`, `/collections/`, trailing `c\d+`)                                                                                                          | **Reusable as detection evidence, not hard classification.** Feed into evidence-scored page-type classification; URL match alone never decides.                    | `salla/page-type-evidence.ts`          |
| R4  | Category→product listing harvesting (`_parse_product_listing`): listing pages emit member product URLs into the frontier                                                                                                                                                     | **Reusable and filling a real OpenSEO gap** (current discovery is sitemap + generic links only; no explicit "listing page → member product URLs" loop).            | `discovery.ts` + `salla/` adapter      |
| R5  | Redirect-chain capture with `follow_redirects=false` loop + chain persistence (`http_client.py::fetch`)                                                                                                                                                                      | **Concept reusable** (OpenSEO already detects chains multi-page; per-URL chain array is a useful addition). Must keep bounded hops + SSRF re-validation per hop.   | `fetch-policy.ts`                      |
| R6  | Retry classification: retry 429/500/502/503/504, never retry 404/410, escalating delays                                                                                                                                                                                      | **Reusable; superseded by plan.** Phase 1 `fetch-policy.ts` already specifies jitter + `Retry-After` — strictly better than fixed 15/45/90s sleeps.                | `fetch-policy.ts`                      |
| R7  | DB-backed pending/processing/completed/failed URL queue with skip-locked selection; pause/resume survives process restart (`url_queue.py`, `engine.py::_check_paused`)                                                                                                       | **Semantics reusable** for Phase 3 cancellation/resume; implementation must stay Cloudflare-Workflows-native (durable steps + checkpoints already exist).          | `SiteAuditWorkflow.ts`                 |
| R8  | Crawl counter model (`total_urls`, `processed_urls`, `total_products`, `total_errors` on crawl row + per-URL status enum)                                                                                                                                                    | **Concept seed for crawl quality metrics** (§3.1 Phase 1/3) — extended to discovered/fetched/analyzed/blocked/failed/skipped/rendering-required.                   | `audits` schema + `AuditRepository`    |
| R9  | Product external ID from URL slug (`_extract_product_id`)                                                                                                                                                                                                                    | **Reusable as weak evidence only.** Never persist as authoritative ID without schema/API corroboration.                                                            | `salla/product-extractor.ts`           |
| R10 | Analytics-payload category mining (`_extract_category` — `"Product Viewed" ... "category"` regex in embedded scripts)                                                                                                                                                        | **Conditionally reusable, lowest-confidence tier.** Real Salla stores embed dataLayer-like events; classify as `evidence: analytics-payload`, never authoritative. | `salla/product-extractor.ts`           |

### 2.5.2 Missing capabilities in `salla-crawler` (relevant to our goals)

- No robots.txt compliance at all (any path fetched; no `Sitemap:` directive use, no disallow checks).
- No bot-challenge/JS-shell detection: challenge pages and CSR shells are parsed as content and emitted as "products/SEO data" — exactly the fabricated-finding class this plan forbids.
- No per-page evidence tracking or confidence; every extracted field is asserted.
- No canonical validation, no Product Schema _validity_ checks (presence only).
- No pagination discovery (`rel=next`, `?page=N`) — and worse, `is_crawlable` rejects **every URL containing "?"** (`IGNORED_PATHS` includes `"?"`), so paginated/filtered catalog URLs are systematically dropped.
- No extraction-completeness or coverage metrics; success = queue drained.
- No SSRF guard, no response-size cap, no charset handling (httpx default), no per-host fairness (delay is per-process; N Celery workers bypass each other).
- No Product↔category association model (single `category` string), no variant stock/price-delta capture (columns exist, never populated), no currency fallback (hardcodes `SAR` at save time).
- Sitemap index handling: one recursion level, stops after first non-empty sitemap (`if found_urls: break`), and `extract_sitemap_index_urls` is a verbatim duplicate of `extract_sitemap_urls` (treats urlsets as indexes by accident).

### 2.5.3 Defects to avoid replicating (verified in code)

| #   | Defect                                                                                                                                                                                        | Evidence                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| D1  | TLS verification disabled everywhere                                                                                                                                                          | `httpx.Client(verify=False)` in `http_client.py` fetch/fallback/sitemap         |
| D2  | Browser-UA impersonation (Chrome string as default UA)                                                                                                                                        | `DEFAULT_USER_AGENT` — anti-bot-adjacent; OpenSEO must identify itself honestly |
| D3  | Query-string-blind crawling (`"?"` in `IGNORED_PATHS`) — drops pagination/filters                                                                                                             | `discovery.py::is_crawlable`                                                    |
| D4  | Cross-subdomain scope creep (`netloc.endswith("."+domain)`)                                                                                                                                   | `discovery.py::is_internal_url` — SSRF surface + crawl drift                    |
| D5  | Sitemap discovery stops at first non-empty hit; 1-level index recursion; identical index/urlset parsers                                                                                       | `engine.py::_discover_urls`, `discovery.py`                                     |
| D6  | Fabricated values: `currency` defaults `"SAR"`, availability coerces anything-not-`InStock` to `out_of_stock` (PreOrder/BackOrder misclassified), unrecognized stock element → `out_of_stock` | `url_queue.py::save_product`, `parser.py::_from_ld_json`, `_parse_stock`        |
| D7  | Parse exceptions swallowed (`except Exception: logger.exception`) after URL already marked `COMPLETED` — failed extraction counts as success                                                  | `engine.py::_process_url`                                                       |
| D8  | Cancellation rewrites pending/processing URLs to `FAILED` — cancelled ≠ failed conflation                                                                                                     | `url_queue.py::cancel`                                                          |
| D9  | In-memory `_seen_urls` dedup seeded only from completed/processing rows; pending rows not seeded → cross-run duplicates; counter increments race                                              | `url_queue.py::initialize/add_urls_batch`                                       |
| D10 | Naive price regex takes first number-looking token (breaks on ranges/Arabic formatting); no currency-symbol association                                                                       | `parser.py::_from_html`                                                         |
| D11 | Product-page detection trusts URL pattern; "Redirecting to…" heuristic string-matched from title                                                                                              | `parser.py`, `engine.py`                                                        |
| D12 | Variant rows written without `stock_status`/`price_difference` extraction (schema promises unfulfilled)                                                                                       | `parser.py::_parse_variants`, `url_queue.py::save_product`                      |
| D13 | New `httpx.Client` per attempt (no pooling); fallback re-fetch after exhaustion doubles load on failure                                                                                       | `http_client.py::fetch`                                                         |
| D14 | All-or-nothing `js_render` per crawl; Playwright `networkidle` with injected `document.referrer` script; no per-page rendering decision                                                       | `http_client.py::fetch_with_js`                                                 |
| D15 | `word_count`/h2 flattening loses structure (h2s joined with `"                                                                                                                                | "`)                                                                             | `parser.py::_parse_seo` |

### 2.5.4 Security risks in the third source

- **S1 — Live-looking credentials in the package:** `.env` (21 keys incl. `POSTGRES_PASSWORD`, `SECRET_KEY`, `DATABASE_URL`, `CELERY_BROKER_URL`) ships inside the unzipped folder. **Action:** never copy the zip/folder into the repo; add nothing to git; treat values as compromised examples. `.gitignore` must never need to protect this — the source stays at `F:\Salla Store Crawler\`.
- **S2 — `verify=False`** disables TLS for all crawling (D1): MITM exposure; any ported fetch logic uses platform TLS defaults.
- **S3 — No SSRF guard / no robots / no scope discipline (D4):** user-supplied start URL is trusted as-is. OpenSEO's `url-policy.ts` + `ssrf-guard.ts` + `global_fetch_strictly_public` remain the only gate; ported discovery logic must route through them, never around.
- **S4 — UA impersonation + injected referrer scripting (D2/D14)** drift toward anti-bot circumvention; explicitly out of bounds per §4.
- **S5 — No auth on the dashboard/API at all** (per `plan.md`: "No authentication/login system is required") — irrelevant as a design (not imported), noted so no unauthenticated-surface patterns leak into OpenSEO.

### 2.5.5 Incompatible components — excluded from OpenSEO entirely

FastAPI/Pydantic/SQLAlchemy backend; Celery + Redis queueing and beat scheduler; standalone PostgreSQL schema (`projects/crawls/urls/links/products/product_variants/images/seo_data/errors/crawl_schedules`); Playwright/Chromium worker bundling; Docker/Nginx/docker-compose deployment; Excel/Pandas report generator; React SPA with WebSocket progress. Rationale: OpenSEO already has equivalents (Workflows, dual-dialect drizzle, R2, TanStack app, MCP) with Cloudflare constraints the Python stack cannot satisfy. Product/variant/image/SEO **data shapes** inform the Salla adapter's extraction contract (§3.1 Phase 2) but are mapped onto OpenSEO's existing `audit_*` schema extensions — no new parallel persistence.

### 2.5.6 Net assessment

`salla-crawler`'s durable value is its **Salla domain heuristics** (R1–R4, R9–R10) and its **defect catalogue** (D1–D15) as a negative-spec for our evidence discipline. Its engineering substrate is fully incompatible. Phase 1–3 acceptance gains concrete negative test cases from D5–D8 (sitemap incompleteness, fabricated stock/currency, parse-failure-as-success, cancel-vs-fail conflation).

---

# 3. Execution Sequence

## 3.0 Pre-flight (before any crawler change)

1. Record baseline manifest: branch, HEAD, `git status --short` (spec-014 file list), stashes. No commits/stashes/discards.
2. `git fetch upstream --tags` (authorized).
3. **Upstream selective review report** (deliverable BEFORE crawler changes): diff `v0.1.9..v0.1.13` filtered to crawler/discovery/sitemap/rendering/challenge/CF-compat surface; per-change classification (§1.1) with port/cherry-pick/skip recommendation and integration risks.
4. Create worktree `F:\SEO-Dashboard\worktrees\p1-crawler` → `feat/p1-crawler-hardening` from `809f142`.

## 3.1 Phases 1–3 — Crawler Milestone (branch `feat/p1-crawler-hardening`, spec 015)

### Phase 1 — Crawler hardening

| Area                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Files                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fetch policy               | Classified outcomes (`ACCESS_BLOCKED`, `BOT_CHALLENGE`, `CAPTCHA_REQUIRED`, `RATE_LIMITED`, `NETWORK_ERROR`, `FETCH_TIMEOUT`, `INVALID_RESPONSE`, `ROBOTS_DISALLOWED`, `PARSE_ERROR`, `CRAWL_CANCELLED`), bounded retries w/ jitter + `Retry-After`, per-host concurrency semaphore inside the 25-wide batch, per-host min delay, charset-aware decode, size enforcement                                                                                                                                                                                                                                                                                                                                                                                                                 | `site-audit-workflow-helpers.ts`, new `src/server/lib/audit/fetch-policy.ts`                                  |
| Expanded blocked detection | Challenge markers on 200 responses, non-Cloudflare vendor fingerprints; persist `failure_reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `site-audit-workflow-helpers.ts`, `types.ts`, `audit-issues.ts`                                               |
| Extraction states          | `STATIC_COMPLETE…EXTRACTION_FAILED` + evidence-based render-requirement heuristics (SPA shell, JS-only ld+json, near-empty body + heavy scripts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `page-analyzer.ts`, `types.ts`                                                                                |
| JSON-LD parsing            | Multi-block + `@graph` extraction into structured payload (capped column or R2 key); microdata itemtype detection best-effort                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `page-analyzer.ts`, schema                                                                                    |
| External links             | Persist external edge rows (target host + nofollow), capped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `AuditRepository.ts`, schema (`audit_links`)                                                                  |
| Issue gating               | Mute content findings on incomplete extraction; new `crawl-error` issue type; no fabricated missing-\* on blocked/partial pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `page-reporters.ts`, `audit-issues.ts`                                                                        |
| Schema columns             | `extraction_state`, `extraction_method`, `failure_reason`, `platform`, `platform_confidence`, JSON-LD payload ref on `audit_pages` (both dialects + parity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/db/audit.schema.ts`, `src/db/pg/audit.schema.ts`                                                         |
| URL discovery hardening    | robots.txt `Sitemap:` directives honored; **all** declared sitemap files and sitemap indexes fanned in (depth-capped recursion, never first-non-empty-hit-only — negative spec D5); duplicate index/urlset parse paths unified; meaningful query parameters preserved through dedup (pagination `?page=N`, filters — negative spec D3) while tracking-params collapse; `rel=next` + paginated listing following; **category/listing → member product URL harvesting into the frontier** (R4); canonical-aware dedup key (normalized host, path, retained-params, no fragment, no default port — D4 scope discipline retained via `isSameOrigin`); discovery coverage ledger per source (sitemaps found/parsed/failed, robots-declared, homepage/link-only) persisted for quality metrics | `src/server/lib/audit/discovery.ts`, `url-utils.ts`, `url-policy.ts`, `siteAuditWorkflowCrawl.ts`             |
| Crawl quality counters     | Persist per-audit metrics columns on `audits`: `urls_discovered`, `urls_fetched`, `urls_analyzed`, `urls_blocked`, `urls_failed`, `urls_skipped`, `urls_rendering_required`; derived `extraction_complete_ratio` (analyzed-complete / fetched-HTML); per-page rows already carry `extraction_state` — counters are computed from rows, never incremented blindly (negative spec D7/D9)                                                                                                                                                                                                                                                                                                                                                                                                   | `src/db/audit.schema.ts`, `src/db/pg/audit.schema.ts`, `AuditRepository.ts`, `site-audit-workflow-helpers.ts` |

### Phase 2 — Salla compatibility (modular adapter)

Design: a self-contained adapter under `src/server/lib/audit/salla/` plugged after generic page analysis. The adapter consumes the already-fetched page (HTML + parsed JSON-LD + headers) — it never fetches on its own, never bypasses `fetch-policy.ts`/SSRF, and returns evidence-shaped partials. **Three evidence tiers are always kept separate and labeled per field:** `html` (visible DOM/public markup) · `structured-data` (JSON-LD/microdata/OG) · `api` (optional Salla OAuth catalog, Phase-2-flagged, mock-only). Cross-tier merge precedence: structured-data > html per field, `api` never overwrites public-evidence fields — it only fills gaps or corroborates, with provenance recorded. **Never manufacture unknown values:** null/`UNKNOWN` survives to persistence; there are no defaults for currency, availability, price, or stock (negative specs D6, D12).

| Area                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Platform detection        | Evidence-scored detector: meta generator, `cdn.salla.sa`/asset-script paths, `salla.*`/`Salla.`JS globals, dataLayer-style `"Product Viewed"`/`"parent"` analytics payloads (lowest tier, R10), URL patterns (R3), headers; weighted score → `platform` + `platform_confidence`; never hostname-only; below threshold → `platform: null` (not "Salla?")                                                                                       | new `src/server/lib/audit/platform-detection.ts`, `page-analyzer.ts`                |
| Page-type classification  | `product                                                                                                                                                                                                                                                                                                                                                                                                                                      | category                                                                            | blog | other` from combined evidence (Product JSON-LD, URL pattern, DOM affordances, OG type); URL pattern alone never classifies (negative spec D11); classification confidence persisted | new `salla/page-type-evidence.ts`, `page-analyzer.ts` |
| Product extraction        | Name, SKU/MPN, price + old/compare price + discount, **currency** (from offers/HTML currency element only — never defaulted), brand, description, availability ladder (R1, incl. Arabic signals, `UNKNOWN` default), images (gallery + JSON-LD, deduped, absolute, alt preserved), **variants/options with per-option stock + price-delta where evidenced** (absent evidence → nulls, not guesses), product external ID as weak evidence (R9) | new `salla/product-extractor.ts`                                                    |
| Category extraction       | Category name/path, breadcrumb-derived hierarchy, **product↔category associations** harvested from listing pages (R4) — association persisted as crawl evidence (not a new product DB); member-product URLs feed the discovery frontier via Phase 1 harvesting                                                                                                                                                                                | new `salla/category-extractor.ts`, `discovery.ts`                                   |
| Blog extraction           | Article/BlogPosting hints: title, publish/modified dates, author where evidenced; reuses generic extraction; no fabrication                                                                                                                                                                                                                                                                                                                   | `salla/blog-extractor.ts` (thin)                                                    |
| Product Schema validation | Parsed Product JSON-LD checked for required/recommended fields (name, image, offers.price, offers.priceCurrency, offers.availability); **validity vs Google rich-result eligibility distinguished**; emits gated `audit_issues` only on `STATIC_COMPLETE` pages; canonical-vs-page-URL consistency validation; conflicting schema/canonical flagged, never silently resolved                                                                  | `salla/schema-validation.ts`, `page-reporters.ts`, `audit-issues.ts`, Phase 4 reuse |
| Canonical validation      | Product/category canonical sanity: self-canonical, canonical→redirect-loop, cross-domain canonical, canonical≠final-URL detection (only on complete extractions)                                                                                                                                                                                                                                                                              | `salla/schema-validation.ts`, `multipage-checks.ts`                                 |
| badseo fixtures           | Salla-shaped fixtures: static product (full), static product (sparse — exercises null honesty), variants, category + pagination (incl. `?page=N`), blog, CSR shell (SPA markers, JS-only ld+json), hybrid static+CSR, 200-served challenge, JSON-LD multi-block `@graph`                                                                                                                                                                      | `badseo/src/fixtures/`                                                              |
| OAuth connector           | Feature-flagged, disabled-by-default module: authorize/token/refresh endpoints per verified current docs, AES-GCM token storage, least-privilege scopes incl. `products.read`, pagination, rate limits, project/store ownership binding; mock integration tests only; **remains disabled until owner-authorized credentials + test store exist** (§1.5); API rows tagged `evidence: api` and never used to assert public-page SEO state       | new `src/server/features/salla/`, `src/serverFunctions/salla.ts`                    |

### Phase 3 — Access, reliability, Cloudflare

| Area                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Graceful cancellation     | Cooperative stop flag between batches; partial results preserved; status `cancelled` (never `completed`); distinct from `deleteAudit` teardown                                                                                                                                                                                                                                                                                                                                                                                  | `SiteAuditWorkflow.ts`, `siteAuditWorkflowPhases.ts`, `AuditRepository.ts`, `AuditService.ts` |
| Progress truthfulness     | Persisted and surfaced quality metrics: queued/discovered/fetched/analyzed/blocked/failed/skipped/rendering-required counts + `extraction_complete_ratio` + evidence-coverage % (share of analyzed pages with per-tier evidence); UI + MCP `get_audit_status` enriched honestly; **an audit with any failed/blocked/skipped/unprocessed URLs never reports full success** — status distinguishes `completed` (full coverage) from `completed_partial` (coverage deficit) with the deficit enumerated; partial crawl ≠ completed | `AuditRepository.ts`, site-audit-tools.ts, audit client                                       |
| Cancel vs fail separation | Cancelled URLs/audits are never rewritten to FAILED or counted as errors (negative spec D8); cancellation leaves per-page states intact and sets audit `cancelled` with preserved metrics                                                                                                                                                                                                                                                                                                                                       | `SiteAuditWorkflow.ts`, `AuditRepository.ts`                                                  |
| Budget/state review       | Frontier + seed caps revisited; per-batch subrequest accounting; resume idempotency tested                                                                                                                                                                                                                                                                                                                                                                                                                                      | `siteAuditWorkflowCrawl.ts`, `siteAuditWorkflowPhases.ts`                                     |

**Milestone tests:** new unit suites (fetch-policy, platform detection, extraction states, JSON-LD parsing, external links, issue gating, dedup under retries, Salla product/category/blog extractors, schema validity); integration (sitemap imports incl. multi-file indexes, batch retry/resume idempotency, cancel-during-crawl, 403/429 fixtures, pagination discovery, listing→product harvesting); badseo fixture assertions; Playwright audit E2E (start → progress → error states → page detail); full regression (existing audits, rank tracking, GSC, autopilot).

**Salla-specific verification gates (all required to close the crawler milestone):**

1. **Fixture baseline comparison:** before any Phase 1–3 change, run `badseo/scripts/run-audit.ts` (plus any generic Salla-capable fixture runs) against the pre-change baseline and capture results; after the changes, every pre-existing fixture assertion must still pass and new Salla fixtures must match their expected evidence matrices. Diff report: new findings vs. muted findings, justified per change.
2. **Fixture coverage matrix (fixtures in `badseo/src/fixtures/`):** static product (full + sparse-null), variants w/ stock + price-delta, variants w/ partial evidence, category with pagination (incl. `?page=N` + `rel=next`), listing→product harvesting, blog post, CSR shell, hybrid static+CSR, 200-served challenge, 503 CF challenge, 403/429, JSON-LD `@graph` multi-block, redirect-chain product, canonical-mismatch product. Each fixture declares expected: page type, platform confidence band, per-field evidence tier + value-or-null, extraction state, expected/muted issues.
3. **Reliability scenarios:** retryable 5xx/429 with `Retry-After`, non-retryable 404/410, mid-crawl cancellation (audit `cancelled`, URLs not rewritten to FAILED, metrics preserved), resume-after-step-restart idempotency (no duplicate pages/links), discovery under missing/partial/duplicate sitemaps, discovery under query-param pagination, incomplete-crawl status truthfulness (fixture deliberately unreachable paths → audit reports `completed_partial`, never full success).
4. **Fabrication guards (negative tests from §2.5):** sparse product fixture must persist null currency/availability rather than defaults (D6); parse-exception fixture → `EXTRACTION_FAILED` state, not completed-with-nulls (D7); challenge fixture → no product rows, no SEO findings (only `crawl-error`/`blocked` diagnostics).
5. **Fixtures vs. live stores, explicitly separated:** fixture validation is the acceptance gate. Live-store runs (only against owner-authorized stores) are reported separately as _supplementary verification_ with their own evidence and never substitute for fixture gates; fixture-validated claims are labeled fixture-validated in the final report (§C).

**Release gates (all must pass):** existing crawls work; static + CSR-honest handling; discovery/dedup reliable (incl. multi-sitemap + pagination); challenge pages never mistaken for content; SSRF intact; diagnostics actionable; crawl quality metrics truthful (incomplete ≠ success); `pnpm test:ci` + `ci:check` + parity green; evaluation-gate report (§1.3).

## 3.2 Phases 4–9 (each its own branch, spec number, and gate; branched from latest verified baseline)

| Phase              | Branch / spec                    | Core deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 Schema Generator | `feat/p1-schema-generator` / 016 | `src/server/lib/schema/` extractors/validators/generator (observed-only property policy — never fabricate reviews/ratings/prices/addresses/authors); per-type coverage (Organization, LocalBusiness, Article, BlogPosting, Product, BreadcrumbList, FAQPage, WebSite, WebPage, Service, Person, Event); validity vs Google rich-result eligibility distinction; existing-vs-proposed diff; audit issues; server functions + editor UI (preview/copy/export); `schema_gap` detector; MCP tool; fabrication-guard tests |
| 5 Internal Linking | `feat/p1-internal-linking` / 017 | Detectors over `audit_links` graph of latest completed audit: orphan candidates (coverage-gated), underlinked, deep, broken (exists), redirect chains (exists), non-indexable targets, anchor-diversity, contextual suggestions from title/H1 (no unrelated link-count padding); evidence refs; UI section; autopilot consumption                                                                                                                                                                                     |
| 6 Cannibalization  | `feat/p1-cannibalization` / 018  | Extend `detectors/cannibalization.ts` (never rebuild): classification tiers `POSSIBLE_CANNIBALIZATION                                                                                                                                                                                                                                                                                                                                                                                                                 | INTENT_DISTINCT                                                                                                                                                                                                                                                                                     | NORMAL_URL_DIVERSITY | NEEDS_REVIEW | INSUFFICIENT_DATA`; historical query→page shift over stored `query_page` facts; coverage-integrity per existing semantics (200+empty rows ≠ gap; missing facts ≠ failed sync); recommendations non-destructive (consolidation/canonical review/intent differentiation only) |
| 7 SERP Clustering  | `feat/p1-serp-clustering` / 019  | `serp_organic_snapshots` table (dual dialect; project/market/device/freshness indexes); writer inside rank-check path with failure isolation (§1.4 invariants); parity migration tests; clustering service (threshold=3, bridge guards, engine/location/language/device/freshness compatibility); coverage states + %; opportunity emission for new-page clusters; forward-looking caveat in UI                                                                                                                       |
| 8 AI Citation Gaps | `feat/p1-ai-citation-gaps` / 020 | `ai_search_runs` + `ai_search_citations` tables (provider/model/prompt/timestamp/citations/fan-outs,text-hash                                                                                                                                                                                                                                                                                                                                                                                                         | observational evidence); mention-vs-citation separation reusing `extractCitations`/`matchedBrand`; gap detector (competitor-cited-where-we're-not, frequently-cited third parties, topic gaps); dashboard surfaces + filters; MCP reads; small-sample uncertainty labels; budgets/privacy preserved |
| 9 Next Actions     | `feat/p1-next-actions` / 021     | Unified action center over existing `opportunities` (NO parallel engine): dashboard section w/ filters (feature/severity/lifecycle/recency/reopened), critical/recent/completed/reopened views; autopilot close-the-loop hooks (completion evidence events); assignee/effort columns only via small approved migration; dedup via existing logicalKey engine                                                                                                                                                          |

Per-phase gates each: dual migrations + parity test green; co-located unit tests; E2E where UI exists; `pnpm test:ci`; `pnpm ci:check`; `pnpm build`; merge to integration baseline only when green.

---

# 4. Cross-Cutting Requirements (per master plan)

- **Architecture:** server function → service → repository; no duplicate crawlers/providers; no Redis/BullMQ; no UI-only fixes for data-integrity problems.
- **Database:** SQLite + PG parity on every change; preserve existing data; validate indexes/uniqueness against representative records.
- **Budget & providers:** no new paid SEO data providers; existing priority/fallback, dedup, circuit breakers, cache TTLs, `40201` non-retryable unchanged; provider failure never counted as negative SEO observation.
- **Security:** SSRF protections intact (two-layer + `global_fetch_strictly_public`); safe redirect resolution; no CAPTCHA solving/proxy rotation/UA impersonation/stealth fingerprints; AES-GCM credential storage; no secrets in logs/traces/errors; project scoping + authorization on every new function (incl. `*.authorization.test.ts`).
- **Observability:** (server ledgers `intelligence_run_detectors`, `opportunity_events`, `autopilot_steps`, plus client Global Debug Trace features as applicable); sensitive values redacted (`scrubGlobalTraceText`).
- **UI/UX:** existing Tailwind 4 + daisyUI patterns; explicit loading/failure/empty states; never misleading success.

## 4.1 Mandatory Constraints (2026-10-19 revision, non-negotiable)

- **Preserve existing OpenSEO crawler architecture and Cloudflare compatibility** — Workflows-based durable crawl stays; no subprocess/browser-bundle dependencies.
- **Do not import the salla-crawler stack** — no Python backend, Redis/Celery, separate database, Docker/Nginx, or its frontend (§1.6, §2.5.5). Algorithm ports are TypeScript re-implementations inside `src/server/lib/audit/`.
- **Do not copy the salla-crawler package or its `.env` into this repository** (S1).
- **Preserve SSRF protections and host rate limits**; every ported discovery/fetch path goes through `url-policy.ts` + per-host throttling; TLS verification never disabled (S2, D1).
- **No new paid providers; no anti-bot circumvention** — no CAPTCHA solving, proxy rotation, UA impersonation, or stealth fingerprints (S4, D2). Blocked is an honest outcome, not an error to route around.
- **SQLite/PostgreSQL schema parity** on every schema change (4 artifacts each; parity test green).
- **No confirmed SEO issue from incomplete or blocked extraction** — uncertainty is reported, full success is never claimed for incomplete crawls, and content findings are gated on `STATIC_COMPLETE`.
- **Preserve all existing uncommitted spec-014 work** (§1.2) — unchanged by this revision.
- **Do not merge or rebase upstream** (§1.1) — unchanged.
- **Salla OAuth remains disabled** until owner-authorized credentials and an authorized test store exist; mock tests only (§1.5).

---

# 5. Final Report Structure (Sections A–G)

Delivered at the end of the wave and after each milestone, exactly as the master plan requires:

- **A. Repository Assessment** — commit/branch, reused components, confirmed defects, missing capabilities.
- **B. Implementation Status** — per phase COMPLETE/PARTIAL/BLOCKED/NOT STARTED with files, migrations, tests, limitations.
- **C. Crawler Verification** — static results, CSR results, Salla discovery, product/category extraction, blocked classification, retries, cancellation/recovery, coverage, regressions. Fixtures vs authorized-live clearly separated.
- **D. Feature Verification** — per capability with actual evidence.
- **E. Test Results** — commands, pass/fail/skip counts, build, migration parity, unresolved failures.
- **F. Cost & Security Review** — no new paid providers; budgets intact; SSRF intact; Salla OAuth owner-authorized-only (or unverified-mock); no anti-bot circumvention; credential handling; bounded cancellable background work.
- **G. Remaining Risks & Next Steps.**

**Status labels:** Salla public crawler → COMPLETE/PARTIAL/BLOCKED per evidence; Salla API connector → IMPLEMENTED–MOCK-TESTED (live verification PENDING); SERP clustering → forward-looking coverage disclosure; rendering → heuristic-only with pilot recommendation if gate fails.

---

# 6. Execution-Time Confirmations

- Verify spec numbers 015–021 are unused (`specs/` currently ends at 014).
- Salla OAuth contracts verified against live official docs at Phase 2 time.
- Worktrees at `F:\SEO-Dashboard\worktrees\` (untracked by git — confirmed safe; add to `.gitignore` if the tooling complains).
- Cloudflare Browser Rendering pricing/limit checks done only if the evaluation gate recommends a pilot.
- `salla-crawler` reference stays outside the repo (`F:\Salla Store Crawler\`); nothing committed from it; its `.env` treated as sensitive (S1).

---

# 7. Implementation Gap Analysis (deliverable detail, 2026-10-19)

Precise gap closure map for the crawler milestone (Phases 1–3). Phases 4–9 are unchanged by this revision and retain their §3.2 deliverables.

## 7.1 File-level change map

**Modified:**

| File                                                                                                                                                                                                                      | Change                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/lib/audit/site-audit-workflow-helpers.ts`                                                                                                                                                                     | classified fetch outcomes, expanded challenge detection (200-interstitials, non-CF vendors), `failure_reason`, quality counter derivation                                                                             |
| `src/server/lib/audit/page-analyzer.ts`                                                                                                                                                                                   | extraction states, evidence-based render-requirement heuristics, multi-block JSON-LD/`@graph` parsing, microdata hints, platform/page-type hook-in                                                                    |
| `src/server/lib/audit/discovery.ts`                                                                                                                                                                                       | robots `Sitemap:` directives, full sitemap/index fan-in (no first-hit stop), unified xml parse, pagination (`rel=next`, `?page=N`), listing→product harvesting, canonical-aware dedup keys, discovery coverage ledger |
| `src/server/lib/audit/url-utils.ts`, `url-policy.ts`                                                                                                                                                                      | meaningful-query-param retention in normalization; unchanged host scope + SSRF gates                                                                                                                                  |
| `src/server/lib/audit/issues/page-reporters.ts`, `multipage.ts`, `multipage-checks.ts`                                                                                                                                    | extraction-gated findings, `crawl-error` issue, canonical-mismatch checks                                                                                                                                             |
| `src/shared/audit-issues.ts`                                                                                                                                                                                              | `crawl-error` + Salla-relevant descriptors (schema-invalid, canonical-mismatch) with how-to-fix                                                                                                                       |
| `src/server/features/audit/services/AuditService.ts`, `src/server/features/audit/repositories/AuditRepository.ts`, `src/server/workflows/SiteAuditWorkflow.ts`, `siteAuditWorkflowCrawl.ts`, `siteAuditWorkflowPhases.ts` | cancellation flag + `cancelled` status, quality counters, partial-success semantics, frontier/seed cap review                                                                                                         |
| `src/server/mcp/tools/site-audit-tools.ts` + audit UI client                                                                                                                                                              | honest status/metrics surfacing (`completed_partial`, per-state counts, coverage %)                                                                                                                                   |
| `src/db/audit.schema.ts`, `src/db/pg/audit.schema.ts`                                                                                                                                                                     | new columns (see §7.3)                                                                                                                                                                                                |

**New:**

| File                                                         | Purpose                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/lib/audit/fetch-policy.ts`                       | retry/backoff/`Retry-After`, per-host concurrency + min delay, charset decode, size caps (R5, R6 hardened)                                                                                          |
| `src/server/lib/audit/platform-detection.ts`                 | evidence-scored platform detection + confidence                                                                                                                                                     |
| `src/server/lib/audit/salla/`                                | adapter: `index.ts` (orchestration), `page-type-evidence.ts`, `product-extractor.ts`, `category-extractor.ts`, `blog-extractor.ts`, `schema-validation.ts`, `evidence.ts` (tier types + provenance) |
| `src/server/features/salla/`, `src/serverFunctions/salla.ts` | OAuth connector, flagged+disabled, mock-tested (§1.5)                                                                                                                                               |
| `badseo/src/fixtures/`                                       | Salla fixture set per §3.1 gate 2                                                                                                                                                                   |
| Co-located `*.test.ts` per new/changed module                | unit suites per §3.1 milestone tests                                                                                                                                                                |

## 7.2 Test cases (new, minimum set)

1. fetch-policy: retry 429/5xx w/ `Retry-After` honored; no-retry 404/410; timeout→`FETCH_TIMEOUT`; charset fixtures (windows-1256 Arabic page); size-cap rejection.
2. Challenge detection: CF 503 challenge, 200-served interstitial, generic vendor fingerprint → `BOT_CHALLENGE`/`ACCESS_BLOCKED`, never parsed as content (D-class negative tests).
3. Extraction states: static-complete, near-empty-body + heavy-scripts → `RENDERING_REQUIRED`, JS-only ld+json → `STATIC_PARTIAL`.
4. JSON-LD: multi-block, `@graph`, malformed block isolation (one bad block never discards others).
5. Discovery: sitemap index w/ N children all consumed; multiple top-level sitemaps from robots; urlset-vs-index discrimination; `?page=1..3` kept + deduped; `utm_*` params collapsed; listing page harvested product URLs enqueued once.
6. Salla adapter: per-field evidence tier asserted; sparse fixture yields nulls not defaults (D6); stock ladder incl. Arabic keywords + `UNKNOWN`; variant stock/price-delta present and absent-evidence null (D12); category→product association set; Product schema validity + rich-result eligibility distinguished; canonical mismatch flagged only on complete extraction.
7. Issue gating: blocked/partial pages produce zero missing-\* findings; parse-exception fixture → `EXTRACTION_FAILED` + `crawl-error`, not completed (D7).
8. Cancellation: mid-crawl cancel → `cancelled`, URLs keep true states, metrics preserved (D8); resume after simulated step failure → idempotent, no duplicate edges.
9. Quality metrics: fixture run with seeded failures/blocked/skipped asserts counters + `completed_partial` status.
10. Authorization: `*.authorization.test.ts` for any new server function (incl. `salla.ts`).

## 7.3 Migration requirements

`audits` (both dialects): `urls_discovered`, `urls_fetched`, `urls_analyzed`, `urls_blocked`, `urls_failed`, `urls_skipped`, `urls_rendering_required` (int, default 0), plus status check-extension allowing `cancelled` / `completed_partial` if statuses are enum-checked.
`audit_pages` (both dialects): `extraction_state`, `extraction_method`, `failure_reason`, `platform`, `platform_confidence`, `page_type`+`page_type_confidence` (Salla/generic), JSON-LD payload ref (capped column or R2 key), `salla_product` payload ref (capped JSON or R2 key, evidence-tier-annotated).
`audit_links` (both dialects): external-edge support (target host + nofollow), existing caps retained.
Artifacts per change: `src/db/audit.schema.ts` + `src/db/pg/audit.schema.ts` + `pnpm db:generate:d1` + `pnpm db:generate:pg` + `schema-parity.test.ts` green. No new product database — Salla extraction maps onto audit schema (§2.5.5).

## 7.4 Integration risks

| Risk                                                                               | Mitigation                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Discovery fan-in increases URL volume vs. `MAX_FRONTIER_LINKS_PER_BATCH`/seed caps | Phase 3 cap review precedes rollout; dedup by canonical key; caps remain hard limits with skip accounting                         |
| Arabic/multibyte fixtures inflate test fragility (encodings)                       | charset-aware decode lands first in Phase 1; fixtures declare encoding                                                            |
| `completed_partial` status ripples into UI/MCP/SAM polling                         | status consumers enumerated at implementation; unknown-status fallback = "not completed"                                          |
| Salla analytics-payload mining (R10) false-positives on non-Salla sites            | gated behind `platform==salla` confidence; lowest evidence tier                                                                   |
| Adapter import creep (Python patterns leaking)                                     | review checklist item: no module bypasses `fetch-policy.ts`; no new persistence outside `audit_*`; no defaults for unknown values |
| spec-014 uncommitted files overlap audit files                                     | baseline manifest (§3.0 step 1) precedes worktree creation; phases run in isolated worktrees                                      |
| Live `.env` from third source entering git                                         | source tree stays outside repo; knip/CI unaffected; no copy step in any script                                                    |

## 7.5 Measurable acceptance criteria (crawler milestone)

1. Discovery: on multi-sitemap fixtures, 100% of declared sitemap files parsed (not first-hit-only); paginated fixtures yield ≥ expected URL count with 0 tracking-param duplicates and 0 meaningful-param losses.
2. Classification: blocked/challenge fixtures → 0 content findings, 100% correct `fetch_class`/`extraction_state`; CSR shell → `RENDERING_REQUIRED`, 0 missing-\* issues.
3. Extraction honesty: sparse-product fixture contains ≥1 explicitly-null field set; audit contains 0 manufactured currency/availability/stock values across all fixtures.
4. Salla extraction: full fixtures ≥95% expected-field evidence match; page-type classification ≥ threshold precision on fixture matrix (0 URL-pattern-only classifications).
5. Quality metrics: counters reconcile exactly with per-page rows (`fetched = analyzed + blocked + failed + skipped + rendering_required`-consistent accounting); seeded-incomplete fixture run reports `completed_partial`, never `completed`.
6. Reliability: retry fixture converges within policy; cancel fixture leaves 0 FAILED-rewrites; resume fixture shows 0 duplicate pages/links.
7. Regression: pre-change `badseo` baseline assertions 100% green post-change; `pnpm test:ci`, `pnpm ci:check`, schema parity, `pnpm build` green.
8. No confirmed SEO issue emitted from any incomplete/blocked extraction (grep-verifiable across fixture outputs).
