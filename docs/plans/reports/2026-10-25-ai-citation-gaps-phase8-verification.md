# Phase 8 - AI Citation Gaps Verification (spec 020)

Date: 2026-10-25
Branch: `feat/p1-ai-citation-gaps`
Base: wave 3 integration baseline with phases 1-7
Worktree: `F:\SEO-Dashboard-worktrees\p1-ai-citation-gaps`

## A. Repository Assessment

- Reused the Prompt Explorer's existing paid answer path: recording happens on
  the cache-miss branch of `fetchOrCacheModelResponse` only, reuses the
  existing citation extraction (`extractCitations`, capped at 25 sanitized
  URLs), and stays inside the established budget, plan gate, and per-model
  error isolation.
- Reused the detector/materializer opportunity path (`DetectorDef`, registry,
  input dispatcher, injected thresholds, opportunity template), the source
  version token machinery (`SourceTokens`), and the MCP project-auth +
  `OpportunityService` read stack.
- No new provider, no new paid call (FR-012, NFR-001), no new opportunity
  engine (FR-010).
- Confirmed gaps: the prompt and the answer text are never persisted (FR-003),
  so run identity is the model plus observation date plus hashes — findings
  can never quote the user's question; mentions (a brand named in the answer)
  are deliberately not part of the stored observations, so the findings are
  citation-scoped by construction (FR-007 separation: only stored citation
  rows are analyzed, and no finding asserts anything about mentions).

## B. Implementation Status

| Deliverable                          | Status   | Evidence                                                                                                                                                                                                                                       |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_search_runs` + `ai_search_citations` (dual dialect) | COMPLETE | `src/db/ai-search.schema.ts` + `src/db/pg/ai-search.schema.ts`; migrations `drizzle/0071_ai_search_observations.sql` and `drizzle-pg/0049_ai_search_observations.sql`, journals retagged; provider/model/model name/prompt hash/prompt length/web-search flag/country code/output tokens/fan-out count/citation count/status/event key/observed timestamp (FR-001, FR-002) |
| Privacy-preserving storage           | COMPLETE | Only hashes, counts, and sanitized URLs are persisted (FR-003); the writer passes `sha256HexFull` of the normalized prompt and of the answer text — never the texts; citations are the already-sanitized `safeHttpUrl` URLs from the existing extraction |
| Deterministic, idempotent recording  | COMPLETE | Run id = sha256(project|eventKey|model) truncated, citation id = sha256(runId|url) truncated; `onConflictDoNothing` under the unique indexes `(project_id, event_key, model)` and `(run_id, url)` — a repeat observation never duplicates rows (FR-005, FR-004) |
| Recording inside the Prompt Explorer | COMPLETE | `recordAiSearchObservation` runs in the cache-miss branch via `waitUntil(Promise.all([cache-write, record]))`, each branch caught and logged separately; a failed write never changes the returned answer (FR-006)                              |
| `ai_search` source version           | COMPLETE | `selectAiSearchVersion` returns the newest recorded run's token (`ai_search:<runId>`); observations are synchronous waitUntil writes with no in-flight marker, mirroring the backlinks precedent (FR-010)                                       |
| `ai_citation_gap` detector           | COMPLETE | `src/server/features/intelligence/detectors/aiCitationGap.ts`; registered in the registry, input dispatcher, thresholds (`THRESHOLD_VERSION` 6 -> 7), and the opportunity template; reads only stored rows, never a provider (FR-010, FR-012)   |
| Three finding families               | COMPLETE | `cited_without_us` (run cited pages, none first-party), `frequent_third_party` (domain cited in >= 3 runs, once per run), `no_cited_sources` (run cited nothing); a run whose only citation is our page and a mixed run never emit a gap (FR-008) |
| Small-sample labels                  | COMPLETE | Below the injected `smallSampleFloor` (5) every finding carries `smallSample` in metrics/coverage flags, a `small_sample:<n> observations (floor <m>)` partial-data note, and confidence 45; `minConfidenceToEmit` (40) stays below the floor so labelled findings still emit (FR-009) |
| First-party identity                 | COMPLETE | `canonicalProjectDomain` normalizes every stored `projects.domain` form (bare domain, `sc-domain:` prefix, full URL) to a bare host with the `www.` alias folded; a project without a usable domain skips loudly (`InsufficientCoverageError`)   |
| Opportunity materialization          | COMPLETE | `ai_citation_gap` template (`type` shared as `AI_CITATION_GAP_TYPE`): family-scoped titles, correlation-only recommendations (no banned causal verbs), impact from log-scaled citation activity plus first-position proximity (FR-010)          |
| Read-only MCP tool                   | COMPLETE | `get_ai_citation_gaps` in `intelligence-tools.ts` (registered via the new grouped `registerIntelligenceTools`), reading `OpportunityService.listOpportunities` filtered to the family type behind `withMcpProjectAuth` (FR-011)                 |
| Bounded reads                        | COMPLETE | The fetcher reads at most `maxRunsRead` (200) runs inside the `freshnessDays` (30) window and caps evidence run ids at 50; citations are already capped at 25 per run (NFR-002)                                                                  |
| Deterministic output                 | COMPLETE | periods derive from the observed window (min/max observedAt), runs sort newest-first with runId tiebreak, domains sort, confidences are per-family constants (NFR-003)                                                                           |

## C. Crawler Verification

Not applicable; the site crawler, audits, and their issue pipeline are
unchanged.

## D. Feature Verification

- Privacy: the recorded run row and citation rows cannot be reconstructed into
  the user's prompt or the answer (hashes, counts, sanitized URLs only);
  covered by a test asserting the recorded payload contains neither the prompt
  nor the answer text.
- Idempotency: the same observation (same answer content, same model) keeps
  the same run id; `onConflictDoNothing` plus the unique indexes make a cache
  replay or a repeated explore converge on the same rows.
- Failure isolation: a rejected repository write is caught behind the
  explorer's answer, logged with its own prefix, and covered by a dedicated
  test that asserts the paid result still renders.
- Cache semantics: a cache hit never re-records (the run was recorded when the
  answer was first observed); covered by a dedicated test.
- Dedup once per run: a domain cited twice inside one answer counts that run
  once for the frequently-cited family; covered by a dedicated test.
- Skip gating: with `ai_search` at version null the full-scan integration
  records the detector as skipped with reason "required source has no
  committed version: ai_search" — never fed empty input as if it were data.
- No causal prose: the detector facts, the template recommendations, and the
  MCP descriptions contain no causal verb; the copy states observed counts and
  the observation basis (out of N recorded answers).
- Small-sample honesty: findings below the floor still emit (the spec's SC-004
  contract) with the label and a lowered confidence, never silently dropped.

## E. Test Results

- Full suite (`pnpm vitest run`): 345/346 files passed; 3352 passed, 3
  skipped, 1 failed. The sole failure is the pre-existing env-gated live-API
  test (`src/server/features/rank-tracking/services/livePausedAccountCheck.test.ts`,
  needs `DATAFORSEO_API_KEY`); it is unrelated to this phase and reproduces on
  the untouched baseline.
- New/updated targeted suites: `aiCitationGap.test.ts` (8),
  `promptExplorer.test.ts` (14, including three new recording tests),
  `intelligence-tools.test.ts` (7, including the new tool),
  `registry.test.ts`, `detectorInputs.test.ts` (full-scan integration now
  expects 15 outcomes with two guarded skips),
  `opportunityTemplates.test.ts` (samples + coverage list extended),
  `SourceTokens.test.ts`, `schema-parity.test.ts` — all green; the
  intelligence feature suite passes 504 tests across 65 files.
- `pnpm types:check` (`tsc --noEmit`): clean.
- `pnpm lint` (`oxlint . --type-aware`): 0 warnings, 0 errors on 1353 files.
- Prettier: repo-wide `prettier --check .` remains blocked on Windows
  checkouts because `core.autocrlf=true` rewrites LF to CRLF (pre-existing,
  already logged in `.agents/PAPERCUTS.md`).
- `pnpm knip`: no findings from this phase after un-exporting the two
  detector-internal helpers; the remaining unused files/exports and duplicate
  exports are pre-existing.
- `pnpm build` (client + SSR + `tsc`): green.
- Playwright: not re-run for this phase — no new route (the findings surface
  through the existing opportunities list) and live observations require real
  Prompt Explorer runs. The MCP read is covered by unit tests.

## F. Cost & Security Review

- No new paid provider, no new provider call, no background job. Recording is
  two bounded inserts per fresh model answer, executed off the response path.
- Storage growth is proportional to the Prompt Explorer runs a project already
  pays for (at most one run row + up to 25 citation rows per fresh answer).
- The analysis read is bounded (200 runs, 30-day window) and the threshold
  bump (`THRESHOLD_VERSION` 6 -> 7) changes the accepted-input hash once, so
  the next scan for each project re-runs detection deliberately.
- Project scoping: every read is project-scoped in SQL; the MCP tool resolves
  the project through `withMcpProjectAuth` (wrong-organization access is
  rejected); the detector requires the project domain, never guesses
  first-party identity.
- No secrets or credentials were added; the tests use synthetic rows and
  hashes.

## G. Remaining Risks & Next Steps

1. Observations only accumulate when a user runs the Prompt Explorer; a
   project that never explores stays without findings (by design, NFR-001).
2. The freshness window (30 days), the small-sample floor (5), and the
   frequently-cited floor (3 runs) are reasoned priors; they are injected,
   echoed in the evidence, and can be recalibrated from the first scans'
   near-miss distributions without a code change.
3. Mentions are not persisted (privacy), so the findings cannot distinguish
   "cited and mentioned" from "mentioned but not cited"; the findings are
   citation-scoped and never claim brand mentions.
4. A project domain is a hard requirement for `cited_without_us`; projects
   with unusable domain records skip the whole detector loudly.
5. The MCP tool surfaces gaps only after a scan consumed the recorded
   observations; the tool description tells assistants to run the explorer +
   a scan first.
6. The next wave phase branches from the integration baseline after this
   phase is merged.