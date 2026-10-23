# P1 Crawler Milestone — Verification Report (Phases 1–3)

Date: 2026-10-23
Branch: `feat/p1-crawler-hardening` (worktree `p1-crawler`)
Base: `fb438c5c` — 10 commits, working tree clean.

## A. Repository Assessment

- Existing Workflows-based audit pipeline (`SiteAuditWorkflow`, durable steps,
  KV progress) was preserved; no subprocess, browser bundle, or Python port.
- The Salla reference implementation (`F:\Salla Store Crawler\`) was read for
  semantics only. Nothing was copied or vendored; all logic is a TypeScript
  re-implementation under `src/server/lib/audit/`.
- Confirmed defect fixed: cold page-analyzer module evaluation inside the first
  concurrent fetch batch blocked the event loop and inflated other pages'
  `responseTimeMs` (false `slow-response` findings in the fixture harness).
  Fixed by pre-warming the analyzer before the first batch in both the harness
  and `runCrawlPhase` (production path).
- Legacy `AuditRepository` monolith split into `AuditRepository` +
  `AuditLifecycleRepository`; oversized client/test modules split per the repo
  max-lines budget.

### Commits

| Hash | Group |
|---|---|
| `4a741a71` | feat(db): extraction columns, salla connection schema, audit URL counters (migrations 0064–0068 / 0042–0046) |
| `2911841c` | feat(salla): OAuth connector, token storage, page extraction |
| `90ac4a98` | feat(crawl): discovery, frontier, throttling, page analysis |
| `6cc66d30` | feat(audit): cancellation, coverage-aware finalize, URL counters |
| `66ee025d` | feat(audit-ui): cancelled / completed_partial surfaces |
| `ee1efdc8` | chore(badseo): fixture site + harness analyzer pre-warm |
| `c2c65507` | refactor(quality): oxlint findings, module splits, dead exports |
| `f99931d7` | refactor(quality): split modules referenced by the sweep |
| `6f53e02e` | style: prettier for remaining src files |
| `ad2747a7` | style: prettier for docs, specs, workspace files |

Diff: 407 files, +55,901 / −6,953.

## B. Implementation Status

| Phase | Status | Notes |
|---|---|---|
| 1 — Fetch hardening & discovery | COMPLETE | Fetch taxonomy (`classify-fetch.ts`), adaptive throttle (`crawl-throttle.ts`), crawl window, robots + full sitemap/index fan-in with coverage ledger, canonical-aware dedup, pagination (`rel=next`, `?page=N`), listing→product harvesting |
| 2 — Salla extraction & platform evidence | COMPLETE (fixtures) | Platform detection with confidence (never hostname-only), page-type evidence, product/category/blog extractors, product JSON-LD validation with rich-result eligibility, canonical-mismatch checks, evidence-gated issues |
| 2 — Salla OAuth connector | IMPLEMENTED–MOCK-TESTED | Disabled by default, feature-flagged; AES-GCM token storage; live verification PENDING (no owner-authorized store) |
| 3 — Cancellation & progress truthfulness | COMPLETE | Cooperative cancel flag, `cancelled` / `completed_partial` statuses, eight URL counters, deficit enumeration, SAM/MCP/UI surfaces |
| Rendering | HEURISTIC-ONLY | `RENDERING_REQUIRED` detection; no browser rendering added |

Migrations (dual dialect): `drizzle/0064`–`0068`, `drizzle-pg/0042`–`0046`
(extraction columns, `salla_connections`, page type, salla extraction JSON,
audit URL counters). `schema-parity.test.ts` green.

## C. Crawler Verification

### Fixture crawl counters (badseo site, measured 2026-10-23)

Crawl of the fixture site through the production `crawlPage` path
(50 discovered URLs, 10-per-batch frontier, throttle pacing 1 s/URL):

| Counter | Value |
|---|---|
| discovered | 50 |
| fetched | 50 |
| analyzed | 50 |
| blocked | 0 |
| failed | 0 |
| skipped | 0 |
| rendering_required | 2 |
| extraction_complete | 43 |
| extraction_complete_ratio | 0.827 |
| frontier remaining | 0 (drained) |

Extraction states: 43 `STATIC_COMPLETE`, 2 `RENDERING_REQUIRED`,
5 `NOT_EXTRACTED`. Fetch classes: 50 `ok`.

Sitemap discovery was partial in this sample (1 document fetched, 1 failed —
the fixture site advertises documents that are intentionally unavailable), and
the crawl still drained its frontier; the harness separately asserts
robots/sitemap discovery behavior.

### Evaluation gate (required before Phase 4)

| Measure | Result |
|---|---|
| Static extraction coverage | 43/50 fetched pages = 86.0% (finalize ratio 82.7% excluding NOT_EXTRACTED from the denominator) |
| URLs requiring rendering | 2/50 = 4.0% |
| Inaccessible/blocked | 0 in the crawl sample; the harness asserts blocked classification for the 403, 429, 200-interstitial challenge, and 503 challenge fixtures |
| Not extracted | 5/50 (no content findings emitted — extraction gating verified by unit tests) |

Analyses that cannot run reliably without rendering (suppressed or incomplete
on `RENDERING_REQUIRED` pages, never reported as findings): product/category/
blog field extraction, Product JSON-LD validation and rich-result eligibility,
schema-vs-canonical consistency, page-level content issues (titles, headings,
thin content), and internal-link discovery below the CSR shell.

**Pilot recommendation: none.** The measured rendering-required share (4%) does
not materially undermine downstream Schema / Internal-Linking accuracy for the
fixture corpus. Revisit if authorized live-store runs show a materially higher
share (guidance: ≥20–30%).

### Reliability scenarios (fixture/unit evidence)

- Mid-crawl cancellation: `cancelled` status, per-page states preserved, no
  rewrites to failed (`siteAuditWorkflowCrawl.cancel.test.ts`).
- Resume idempotency: `AuditRepository.idempotency.test.ts` — no duplicate
  pages/links on step replay.
- Retryable 429/5xx with `Retry-After`, non-retryable 404/410: covered by
  fetch/throttle unit suites and fixture status pages.
- Incomplete crawl truthfulness: coverage deficit ⇒ `completed_partial`, never
  full success (`finalize.test.ts`, harness counter assertions).

### Fixtures vs live stores

All verification above is **fixture-validated**. No authorized live Salla store
was available; live-store runs are reported as absent rather than substituted.

## D. Feature Verification

| Capability | Evidence |
|---|---|
| Platform detection | `platform-detection.test.ts` — weighted evidence, below-threshold ⇒ `null` |
| Extraction states | `page-analyzer.test.ts` — CSR shell ⇒ `RENDERING_REQUIRED`, JS-only ld+json ⇒ `STATIC_PARTIAL` |
| JSON-LD multi-block / `@graph` | `seo-json-ld.test.ts`, salla `schema-validation.test.ts` |
| Sparse-product honesty | sparse fixture persists null currency/availability (no defaults) |
| Issue gating | blocked/partial pages emit zero content findings; `crawl-error` diagnostic instead |
| Cancellation | unit + workflow tests listed above; status enum extended in `audit-fetch-class.ts` |
| Progress truthfulness | counters aggregation in `AuditRepository.getAuditPageCounters`; deficit summary in MCP `get_audit_status` and the UI banner |
| UI | Stop audit (confirmation → cancel mutation), cancelled/partial badges, early-stop banner, partial-deficit banner |
| badseo harness | 56/56 checks passed (cold + warm) |

## E. Test Results

| Gate | Result |
|---|---|
| Full suite (`vitest run`) | 328 files — 3,215 passed, 3 skipped, 0 failed |
| TypeScript (`tsc --noEmit`) | exit 0, zero errors |
| Lint (`oxlint --type-aware`) | 0 errors (181 fixed in this wave) |
| Format (`prettier --check`) | 0 drift (265 files normalized) |
| Knip | 468 → 462 findings (224 exports + 238 types); all remaining verified pre-existing at `fb438c5c`; zero new unused exports/symbols |
| Schema parity | `schema-parity.test.ts` green for the new columns |
| badseo gate | ALL 56 CHECKS PASSED (cold and warm runs) |

Note: the repo's LiveReview pre-commit gate could not reach
`livereview.hexmos.com` from this machine; commits used the documented
`lrc review --skip` attestation path.

## F. Cost & Security Review

- No new paid providers; provider budgets, priority/fallback, and circuit
  breakers unchanged.
- SSRF protections intact (two-layer + `global_fetch_strictly_public`); all
  ported fetch paths still route through `url-policy.ts` and per-host throttling.
- Salla OAuth stays disabled by default and mock-tested; tokens AES-GCM
  encrypted; no credentials in logs/traces.
- No anti-bot circumvention: challenges are classified honestly as blocked.
- Background work remains bounded and cancellable (Workflows steps, cooperative
  cancel flag, no process termination).

## G. Remaining Risks & Next Steps

1. **Drizzle snapshot gap** — snapshots exist only through `0065`/`0043`; the
   later migrations (`0066`–`0068`, `0044`–`0046`) were hand-added. The next
   `drizzle-kit generate` diffs against the last snapshot and may re-emit those
   changes; regenerate snapshots before the next schema change.
2. **No live-store validation** — fixture gates are the acceptance basis;
   schedule an owner-authorized store run when available.
3. **Intermediate commit buildability** — `c2c65507` alone does not resolve the
   split-module imports it references (fixed by `f99931d7`); HEAD is green.
4. **Harness cold-start gotcha** — document the analyzer pre-warm requirement in
   `.agents/PAPERCUTS.md` so future harness scripts do not reintroduce
   response-time contamination.
5. **`NOT_EXTRACTED` semantics** — 5 fixture URLs land in this state; document
   per-page reasons in the UI detail view if users ask.
6. Next: Phase 4 (Schema Generator, spec 016) in an isolated worktree branched
   from this verified HEAD.
