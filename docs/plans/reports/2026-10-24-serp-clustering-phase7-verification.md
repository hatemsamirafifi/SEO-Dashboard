# Phase 7 - SERP Clustering Verification (spec 019)

Date: 2026-10-24
Branch: `feat/p1-serp-clustering`
Base: `93bf0f59` (wave 3 integration baseline with phases 1-6 merged)
Worktree: `F:\SEO-Dashboard-worktrees\p1-serp-clustering`

## A. Repository Assessment

- Reused the organic results the rank check already paid for. The provider
  responses already carried the full organic list; only the target match was
  kept. The capture seam is now the only change to the provider contract, and
  it is optional (`NormalizedSerpResult.organicResults`).
- Reused the existing rank-check write path, the detector/materializer
  opportunity path, the rank-tracking config detail surface, the shared page
  identity helper (`canonicalUrl`), and the repo's coverage vocabulary.
- No new provider, no new paid call, no new table beyond the one the plan
  names, and no new opportunity engine.
- Confirmed gaps: the top-10 set can be truncated by DataForSEO's
  `stop_crawl_on_match`, so the completeness status records a partial set
  instead of assuming a full page; no E2E fixture flag exists for rank-tracking
  organic data, so the surface is covered by unit tests and the existing
  Playwright specs stay green.

## B. Implementation Status

| Deliverable                             | Status   | Evidence                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serp_organic_snapshots` (dual dialect) | COMPLETE | `src/db/serp.schema.ts` + `src/db/pg/serp.schema.ts`; keyword, engine, location code/name, language, device, position, URL, normalized URL, title, domain, provider, run id, config id, project id, tracking keyword id, observed timestamp, completeness status |
| Migrations and parity                   | COMPLETE | `drizzle/0070_serp_organic_snapshots.sql`, `drizzle-pg/0048_serp_organic_snapshots.sql`; journal retagged; the parity suite gained an explicit column and index assertion (264 tests)                                                                            |
| Capture inside the rank check           | COMPLETE | `RankCheckResult.organicResults` (DataForSEO live and queued), `NormalizedSerpResult.organicResults` (provider contract), the HTTP providers fill the list they already parse                                                                                    |
| Failure isolation                       | COMPLETE | `rankCheckPaths.ts` writes the organic rows inside their own `try/catch`; a failing write is warned about and never changes the rank snapshot, the run status, or the provider failure semantics                                                                 |
| Clustering service                      | COMPLETE | `clusterCore.ts` (threshold, bridge guard, deterministic ordering, coverage) and `SerpClusteringService.getClusters` (project-scoped, market/device scoped, freshness window)                                                                                    |
| Coverage states and percentage          | COMPLETE | `ready`, `awaiting_data`, `insufficient_data`, `stale_data` plus the share of tracked keywords with usable data                                                                                                                                                  |
| Opportunity emission                    | COMPLETE | `serp_cluster_new_page` detector, registered in the registry, dispatcher, thresholds, template, client types, and boundary allowlists; the template copy is a review suggestion with the forward-looking caveat                                                  |
| Surface                                 | COMPLETE | `getSerpClusters` server function (project-scoped, authorization tested) and the SERP clusters section in the rank-tracking config detail view, with the coverage badge, the clusters, and the caveat                                                            |
| Threshold and version bumps             | COMPLETE | `THRESHOLD_VERSION` 5 -> 6 (`minKeywordThreshold`, `minCoverageRatio`, `minClusterPages`, `freshnessDays`); the new detector starts at version 1                                                                                                                 |

## C. Crawler Verification

Not applicable; Phases 1-3 remain unchanged. Phase 7 touches the rank-check path,
not the site crawler.

## D. Feature Verification

- No new provider call: the organic rows come from the responses the rank check
  already bought. The capture is capped at ten rows per keyword and device.
- Failure isolation: a failing organic write is reported on its own and leaves
  the rank check untouched (covered by a dedicated test).
- Coverage integrity: the coverage state is `awaiting_data` when nothing was
  stored, `insufficient_data` below the coverage ratio, `stale_data` for old
  observations, and `ready` otherwise. The share is always the covered share of
  the tracked keywords - never a rounded-up claim.
- Market and device compatibility: the read filters on the config's location
  code, language, and the requested device, and only rows inside the freshness
  window are clustered.
- Bridge guard: the co-occurrence graph only keeps edges whose shared keyword
  count reaches the threshold, so groups that would only be joined by a weakly
  shared page stay apart.
- New-page detection: a cluster page outside the tracked domain is a new-page
  candidate; a cluster made only of the project's own pages is not emitted.
- Observational prose: the detector prose, the template recommendation, and the
  client caveat contain no causal verb, and the surface states that the
  analysis is forward-looking rather than a prediction.

## E. Test Results

- `pnpm test:ci` (full suite): 344/345 files passed; 3340 passed, 3 skipped,
  1 failed. The sole failure is the pre-existing env-gated live-API test
  (`src/server/features/rank-tracking/services/livePausedAccountCheck.test.ts`,
  needs `.env.local`/`.env`); it is unrelated to this phase and reproduces on
  the untouched baseline.
- New/updated targeted suites: `clusterCore.test.ts` (8),
  `SerpClusteringService.test.ts` (4), `serpClusterNewPage.test.ts` (4),
  `organicRows` capture coverage in `rankCheckPaths.test.ts` (13),
  `serpClusteringCopy.test.ts` (4), `rank-tracking.authorization.test.ts` (1),
  `schema-parity.test.ts` (264), `detectorInputs.test.ts` (25),
  `opportunityTemplates.test.ts` (19) - all green.
- `pnpm types:check` (`tsc --noEmit`): clean.
- `pnpm lint` (`oxlint . --type-aware`): 0 warnings, 0 errors on 1348 files.
- Prettier: all changed files formatted. Repo-wide `prettier --check .` still
  fails on Windows checkouts because `core.autocrlf=true` rewrites LF to CRLF
  (pre-existing; logged in `.agents/PAPERCUTS.md`).
- `pnpm knip`: no clustering-related findings after un-exporting the
  internal-only symbols; the remaining 3 unused files, 224 unused exports, and
  4 duplicate exports are pre-existing.
- `pnpm build` (client + SSR + `tsc`): green.
- Playwright: not re-run for this phase - no new route, and the cluster section
  needs stored organic rows that only a live rank check can produce. The
  existing opportunities, audit, and dashboard specs are unaffected.

## F. Cost & Security Review

- No new paid provider, no new provider call, and no background job. The
  capture adds one bounded insert per fulfilled rank check.
- Storage growth is proportional to the rank checks a project already runs
  (at most ten rows per keyword and device), and the clustering read is capped
  at 5,000 rows per config and device.
- Project scoping: the server function middleware rejects wrong-organization
  access, and the service reads the config through the project-scoped
  repository lookup.
- No secrets or credentials were added; the tests use synthetic rows.

## G. Remaining Risks & Next Steps

1. The provider's `stop_crawl_on_match` can shorten the organic set. The
   completeness status records that, but a live call should confirm how often
   the top-10 set is actually truncated.
2. The clustering threshold (three shared keywords) and the freshness window
   (30 days) are reasoned priors. They are injected and echoed in the evidence,
   so the first production scans can recalibrate them without a code change.
3. The cluster detector reads up to five configs per scan and both devices per
   config. A project with many configs will produce more clustering work per
   scan; the cap keeps it bounded.
4. The new table adds a write to the rank-check path. The write is isolated, but
   a project with a large keyword set will store noticeably more rows.
5. Live-store validation of the clustering thresholds remains pending
   (fixture-only acceptance basis).
6. The next wave phase (8, AI Citation Gaps, spec 020) branches from the
   integration baseline after this phase is merged.
