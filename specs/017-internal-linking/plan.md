# Implementation Plan: Internal Linking Opportunities Engine

**Branch**: `feat/p1-internal-linking` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/017-internal-linking/spec.md`

## Summary

Add an internal-linking analysis layer over the stored audit graph. The crawler persists the first observed H1 text so suggestions have real page context. A bounded repository reads pages and SQL-aggregated inbound link statistics; a pure analyzer produces coverage, findings, and suggestions; the existing multipage finalize pass persists new issue types; and the audit results UI gains an Internal Linking tab. The existing technical SEO autopilot consumes the new issue types automatically.

No new crawl, provider, queue, or opportunity engine.

## Technical Context

**Language/Version**: TypeScript, Node.js runtime (package.json engines), Vite build, Vitest, React 19, TanStack Router/Query/Start.

**Primary Dependencies**:

- `src/db/audit.schema.ts`, `src/db/pg/audit.schema.ts` - `audit_pages`, `audit_links`, `audit_issues`.
- `src/server/lib/audit/issues/multipage.ts` - existing finalize checks.
- `src/server/lib/audit/issues/multipage-checks.ts` - pure duplicate/redirect/canonical helpers.
- `src/server/features/audit/repositories/AuditRepository.ts` - project-scoped audit reads.
- `src/serverFunctions/audit.ts` - audit server functions and E2E fixture hook.
- `src/client/features/audit/results/ResultsView.tsx` - results tabs.
- `src/shared/audit-issues.ts` - issue registry.
- `src/server/features/autopilot/services/autopilotWorkflowContent.ts` - `rankIssues`.

**Storage**: SQLite/D1 and Postgres parity. Add `audit_pages.h1_text` (nullable text). No new tables.

**Testing**: Vitest co-located unit tests; server-function authorization test; Playwright E2E with audit fixtures; `pnpm test:ci`, `pnpm ci:check`, `pnpm build`.

**Target Platform**: Cloudflare Workers (D1/Workflows) and Postgres self-host.

**Project Type**: Web service with server function -> service -> repository layering.

**Performance Goals**: Report reads bounded to pages (<= audit max), one aggregate inbound query, and at most 200 candidate targets with inbound edges. No all-edge load.

**Constraints**: Coverage-gated absence findings; observed-only evidence; no fabricated values; D1 row/parameter limits; 400-line file / 320-line function lint limits; project scoping on every new server function.

**Scale/Scope**: One audit at a time; up to the configured max pages; issue caps at 2,000 per new type; 200 targets and 3 suggestions per target in the report.

## Constitution Check

- **Project scope / authorization**: server function middleware + service audit lookup; `NOT_FOUND` before repository reads. Covered by `audit.authorization.test.ts`.
- **Dual dialect parity**: schema change in both dialects; parity test; migrations 0069/0047.
- **Observed-only**: every finding/suggestion uses stored fields; no inferred link counts or fabricated H1s.
- **No competing architecture**: reuse multipage checks, issue registry, results tabs, and technical SEO autopilot.
- **Truthfulness**: partial coverage is explicit; heuristics are labeled candidates; evidence refs are returned.
- **Bounded cost**: SQL aggregates, caps, no provider calls.
- **Testing**: unit matrices for coverage/thresholds/suggestions; E2E for the tab; full gates.

## Design

### 1. H1 persistence

- Add `h1Text: text("h1_text")` to `auditPages` in both schemas.
- In `crawlPage`, set `h1Text` to the first non-empty trimmed H1, capped at 500 characters; null for non-HTML/failed/partial pages.
- Persist in `insertCrawledBatch`.
- Update `CrawledPageResult` fixtures and the E2E page fixture.
- Generate migrations 0069 (SQLite) and 0047 (Postgres), repairing the stale snapshot chain.

### 2. Linking data access

New `src/server/features/audit/repositories/linkingQueries.ts`:

- `getLinkingPages(auditId)`: bounded page columns including `h1Text`, `pageType`, `crawlDepth`, `inSitemap`, `isIndexable`, canonical fields, status/fetch class, word count, extraction state.
- `getInboundStats(auditId)`: one grouped query over followed internal links:
  - `targetUrl`
  - `inboundLinks` (`count`)
  - `inboundSources` (`countDistinct(sourcePageId)`)
  - `distinctAnchors` (`countDistinct(lower(trim(coalesce(anchor, ''))))`)
  - `emptyAnchors` (`sum(case when trim(coalesce(anchor,'')) = '' then 1 else 0 end)`)
  - `sampleAnchor` (`max(anchor)`)
- `getInboundEdgesForTargets(auditId, targetUrls)`: bounded source URL/anchor rows for candidate targets (used to exclude existing sources and show evidence).
- `getLinkingIssueRows(auditId)`: stored issue rows for linking types (for summary/examples).

All queries filter `isInternal = true` and exclude `isNofollow = true` where equity counts are needed. Observed issue queries (broken/redirect/non-indexable) use followed and nofollow as appropriate.

### 3. Pure analyzer

New `src/server/lib/audit/linking/`:

- `types.ts`: page/stat/finding/suggestion/report types.
- `analyze.ts`:
  - `UTILITY_PATH_PATTERNS` (cart, checkout, account, login, search, wishlist, compare, etc.).
  - `isUtilityUrl`, `isOkHtml`, `isIndexableTarget`, `effectiveCanonical`.
  - `buildInternalLinkingReport({ audit, pages, inboundStats, inboundEdges, issueRows })`.
  - `buildUnderlinkedFindings`, `buildAnchorDiversityFindings`, `buildNonIndexableTargetFindings`.
  - `suggestSources(target, pages, existingSources, tokenIndex)`.
  - Tokenization: Unicode-aware lowercase, split on non-letter/number, stopword set for English/Arabic common words, min token length 3.
  - Suggestion score: title token overlap (weight 3), H1/Salla entity name overlap (weight 4), same page type (weight 2), shared URL path segment (weight 1). Require at least one shared title/H1 term; cap 3.
- `analyze.test.ts`: thresholds, coverage gating, suggestions, dedupe, Arabic tokens.

### 4. Issue persistence

Extend `runMultipageChecks`:

- Add `inSitemap`, `crawlDepth`, `h1Text` to the page select.
- Load inbound stats once.
- On `crawlCompleted` and `pages.length >= 10`, append underlinked and anchor-diversity findings.
- Always append non-indexable target findings (observed).
- Reuse existing orphan/deep/broken/redirect findings; do not duplicate.
- Caps: `LINKING_ISSUE_CAP = 2_000` per new type.
- Details:
  - `underlinked-page`: `{ inboundLinks, inboundSources, inSitemap, pageType, crawlDepth }`.
  - `anchor-text-diversity`: `{ inboundLinks, distinctAnchors, emptyAnchors, sampleAnchor }`.
  - `link-to-noindex-page`: `{ targetUrl, reason: "noindex" | "canonicalized", canonicalUrl }`, `dedupeKey: targetUrl`.
- Add descriptors to `AUDIT_ISSUE_TYPES`.

### 5. Report service and server function

- `src/server/features/audit/services/InternalLinkingService.ts`:
  - `getReport({ auditId, projectId })`.
  - Load project-scoped audit via `AuditRepository.getAuditForProject`; throw `NOT_FOUND` if absent.
  - Load pages, inbound stats, candidate edges, linking issue rows in parallel.
  - Build report; return.
- `src/serverFunctions/audit.ts`:
  - `getInternalLinkingReport` with `getAuditResultsSchema` validator.
  - E2E fixture fallback via `audit-linking-fixtures.ts`.
- `src/serverFunctions/audit.authorization.test.ts`: add mock and wrong-project case.

### 6. UI

- Add `"linking"` to `auditTabs` in `src/types/schemas/audit.ts`.
- `ResultsView`: `ResultsTab` includes `"linking"`; add tab; hide export dropdown for linking; render `InternalLinkingView`.
- `src/client/features/audit/results/InternalLinkingView.tsx`:
  - `useQuery(["audit-linking", projectId, auditId], getInternalLinkingReport)`.
  - Coverage banner: complete vs partial with reason.
  - Summary cards: internal links, orphan candidates, underlinked, deep, broken, redirects, non-indexable targets, anchor issues.
  - Table/cards of affected targets: URL, type badge, depth, inbound count, suggestions with shared terms.
  - Empty state when no findings; loading skeleton; error state.
- Add `data-testid`s for E2E.

### 7. Autopilot

- No workflow change. New issue types flow through `getIssueTypePageCountsForAudit` and `rankIssues`.
- Add a focused test asserting `rankIssues` includes `underlinked-page`/`anchor-text-diversity` and preserves severity ordering.

### 8. E2E

- `e2e/fixtures/audit-linking-fixtures.ts`: deterministic report for `e2e-audit` with complete coverage, orphan/underlinked targets, suggestions, and one broken-link example.
- `e2e/audit-internal-linking.spec.ts`: open `?auditId=e2e-audit&tab=linking`; assert summary, coverage, suggestion terms, and empty/no-error state.

## Tasks

See [tasks.md](./tasks.md).

## Verification

1. `pnpm types:check`
2. `pnpm prettier --check` on changed files (or `pnpm format:check`)
3. `pnpm oxlint`
4. Targeted Vitest: linking analyzer, issue builders, autopilot, authorization.
5. `pnpm db:migrate:local`; Playwright `audit-internal-linking`.
6. `pnpm test:ci`; `pnpm ci:check`; `pnpm build`.
7. `pnpm knip` (new exports/files).

## Risks

- Large link graphs: mitigated by SQL aggregates and caps; no all-edge load.
- Heuristic false positives: underlinked is explicitly a candidate; partial coverage suppresses absence findings; thresholds centralized and tested.
- H1 column migration: dual migrations + parity; old audits fall back to title-only suggestions.
- D1 parameter limits: issue inserts already chunk; report queries are aggregate/bounded.
