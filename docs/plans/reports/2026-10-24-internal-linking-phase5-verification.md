# Phase 5 - Internal Linking Opportunities Engine Verification (spec 017)

Date: 2026-10-24
Branch: `feat/p1-internal-linking`
Base: `636ffec2` (Phase 4 schema generator HEAD)
Worktree: `F:\SEO-Dashboard-worktrees\p1-internal-linking`

## A. Repository Assessment

- Reused the stored audit graph (`audit_pages`, `audit_links`, `audit_issues`)
  instead of adding a crawl, provider, or queue. No outbound fetch happens at
  report time.
- Followed the existing layering: TanStack server function -> service ->
  repository, with project scoping enforced by the existing middleware plus a
  project-scoped audit lookup in the service.
- Reused the existing issue registry, multipage finalize pass, results tab
  pattern, and the technical SEO autopilot ranking path. No new workflow.
- Gaps: no live-store validation (fixtures only); Postgres migrations are
  generated and parity-checked but not applied against a live Postgres
  instance; the "observed Salla entity name" is sourced from the observed H1
  (the plan's fallback), not from the stored Salla extraction JSON.

## B. Implementation Status

| Deliverable                                | Status   | Evidence                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 persistence (both dialects)             | COMPLETE | `h1Text` column in `src/db/audit.schema.ts` + `src/db/pg/audit.schema.ts`; `CrawledPageResult.h1Text`; `firstH1Text()` (trim, cap 500) in `site-audit-workflow-helpers.ts`; null for non-HTML/failed/partial; persisted by `insertCrawledBatch`                     |
| Dual migrations                            | COMPLETE | `drizzle/0069_audit_page_h1_text.sql`, `drizzle-pg/0047_audit_page_h1_text.sql`; journals retagged; snapshots `0069`/`0047` regenerated; `schema-parity.test.ts` 261/261                                                 |
| Pure linking analyzer                      | COMPLETE | `src/server/lib/audit/linking/{types,rules,suggestions,analyze,report}.ts`; orphan, underlinked, deep, broken, redirect, non-indexable-target, anchor-diversity detectors; Unicode tokenization with English/Arabic stopwords      |
| Bounded repository queries                 | COMPLETE | `src/server/features/audit/repositories/linkingQueries.ts`; one grouped inbound-stats query, 2,000-row edge caps, 90-target IN chunks, 200-target report cap, 5-evidence cap                                                     |
| Issue persistence in the finalize pass     | COMPLETE | `runMultipageChecks` now loads inbound stats once and appends `underlinked-page`, `anchor-text-diversity`, and `link-to-noindex-page`; the duplicate broken-link query was removed in favor of the shared linking query                                               |
| Coverage gating                            | COMPLETE | Absence-based findings (orphan, underlinked, anchor diversity) are emitted only on a completed crawl; partial crawls still report observed broken links and non-indexable targets                                                            |
| Small-site suppression                     | COMPLETE | `MIN_PAGES_FOR_STRUCTURE = 10`; underlinked and anchor-diversity heuristics do not run on audits with fewer than 10 crawled pages (spec edge case)                                                                                                                                     |
| Report service + server function           | COMPLETE | `InternalLinkingService.getReport` (project-scoped, `NOT_FOUND` when the audit is not in the project) and `getInternalLinkingReport` with `getAuditResultsSchema` validation and an E2E fixture fallback                                      |
| Authorization coverage                     | COMPLETE | `src/serverFunctions/audit.authorization.test.ts` adds the wrong-project case for `getInternalLinkingReport`; the service refuses before repository reads                                                                                                                        |
| Internal Linking tab                       | COMPLETE | `auditTabs` + route/ResultsView tab types, `InternalLinkingView.tsx` with loading, partial-coverage, empty, error, and populated states; summary counts, target cards, inbound counts, depth, suggestions with shared terms; export hidden for the tab |
| Autopilot consumption                      | COMPLETE | No workflow change; the new issue types flow through `getIssueTypePageCountsForAudit` and `rankIssues`; a focused autopilot test asserts the new types are ranked with their severities                                              |
| E2E                                        | COMPLETE | `e2e/audit-internal-linking.spec.ts` + `e2e/fixtures/audit-linking-fixtures.ts`; complete-coverage and partial-coverage audits, gated by `VITE_E2E_AUDIT_FIXTURES`                                                                                                                          |

## C. Crawler Verification

- Phases 1-3 remain unchanged at `17091a54` and are covered by
  `docs/plans/reports/2026-10-23-crawler-milestone-verification.md`.
- Phase 5 changes the crawler only to persist the first observed H1 text
  (`MAX_H1_TEXT_CHARS = 500`); no fetch, parsing, or scheduling change.
- `site-audit-workflow-helpers.test.ts` (10/10) and
  `AuditRepository.idempotency.test.ts` (2/2) pass with the new field.

## D. Feature Verification

- Observed-only: every finding derives from stored `audit_pages`/`audit_links`
  rows. Absence-based detectors are gated on a completed crawl and are
  additionally suppressed for audits with fewer than 10 crawled pages.
- Truthful coverage: the report returns `complete` only for a `completed`
  audit; otherwise `partial` with the audit status and an explicit reason.
- Honest naming: underlinked pages are reported as candidates; the issue
  descriptor states the crawl only sees links rendered in readable HTML.
- Bounded: inbound counts are aggregated in SQL, at most 200 candidate targets
  and 3 suggestions per target are returned, evidence is capped at 5 rows per
  target, and each new issue type is capped at 2,000 rows per audit.
- Deterministic: findings, targets, and suggestions are sorted by stable keys
  (severity, issue type, page URL, target URL, source URL), so identical
  stored inputs produce identical reports.
- Dedupe: issue rows use the existing deterministic id
  (audit + page URL + issue type + dedupe key); `link-to-noindex-page` dedupes
  on the target URL, so repeated links to the same target collapse into one
  issue per source page.
- Authorization: wrong-project access fails with `NOT_FOUND` before any
  linking query runs.

## E. Test Results

- `pnpm test:ci` (full suite): 338/339 files passed; 3297 passed, 3 skipped,
  1 failed. The sole failure is
  `src/server/features/rank-tracking/services/livePausedAccountCheck.test.ts:48`
  (`expected undefined to be defined`), a live DataForSEO API test whose
  `loadLocalEnv()` reads `.env.local`/`.env` (absent in this worktree). It is
  pre-existing, unrelated to linking, and identical to the Phase 4 baseline.
- New/updated targeted suites: `linking/analyze.test.ts` (16),
  `linking/report.test.ts` (6), `linking/suggestions.test.ts` (2),
  `multipage.linking.test.ts` (2, D1-backed), `InternalLinkingService.test.ts`
  (3), `audit.authorization.test.ts` (10), `autopilotTechnicalSeo.test.ts` (8),
  `schema-parity.test.ts` (261), `site-audit-workflow-helpers.test.ts` (10) -
  all green.
- `pnpm types:check` (`tsc --noEmit`): clean.
- `pnpm exec tsc --noEmit -p badseo/tsconfig.json`: clean.
- `pnpm lint` (`oxlint . --type-aware`): 0 warnings, 0 errors on 1331 files.
- Prettier: all changed files are formatted. Note: `prettier --check .` fails
  repo-wide on this Windows checkout because `core.autocrlf=true` rewrites LF
  to CRLF (the same failure reproduces in the untouched main worktree), so the
  formatting gate was run against the changed files only.
- `pnpm knip`: no linking-related findings after un-exporting four
  internal-only helpers (`findRedirectIssues`, `tokenize`,
  `effectiveCanonical`, `isCanonicalSelf`). The remaining 3 unused files, 224
  unused exports, and 4 duplicate exports are pre-existing.
- `pnpm exec playwright test e2e/audit-internal-linking.spec.ts`: 2/2 passed
  (complete-coverage report with suggestions and hidden export; partial-coverage
  report suppressing absence findings). The pre-existing
  `e2e/audit-schema-editor.spec.ts` still passes 2/2.
- `pnpm build` (client + SSR + `tsc`): green.

## F. Cost & Security Review

- No new paid providers, API keys, background jobs, or network reads at report
  time. The report reads the stored audit graph only.
- Query bounds keep D1 usage predictable: one grouped inbound-stats query,
  capped edge queries, chunked `IN` clauses, capped report output.
- Project scoping is enforced in the server function middleware and again in
  the service's project-scoped audit lookup; no cross-project audit data is
  returned.
- No secrets or credentials were added; the E2E fixtures are synthetic.

## G. Remaining Risks & Next Steps

1. `prettier --check .` cannot pass on Windows checkouts with
   `core.autocrlf=true`; adding a `.gitattributes` with `* text=auto eol=lf`
   would make the repo-wide formatting gate meaningful on every platform.
2. The Postgres migration `0047` is generated and parity-checked but not
   applied against a live Postgres instance; apply it in a self-hosted
   environment before release.
3. Suggestions use the observed H1 as the page-context signal. If the Salla
   entity name should take precedence, add the stored extraction name to the
   page projection and re-score.
4. Live-store validation remains pending (fixture-only acceptance basis).
5. Phase 4 is still unmerged into `feat/speckit-wave3-impl`; merge Phase 4
   first, then Phase 5, from a clean integration worktree.
