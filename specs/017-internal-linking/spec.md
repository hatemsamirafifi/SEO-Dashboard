# Feature Specification: Internal Linking Opportunities Engine

**Feature Branch**: `017-internal-linking`

**Created**: 2026-10-23

**Status**: Implemented - Phase 5 delivered 2026-10-24: H1 persistence in both dialects (migrations 0069/0047), a pure linking analyzer with coverage gating and small-site suppression, bounded linking queries, a project-scoped report service and server function, three new persisted issue types (`underlinked-page`, `link-to-noindex-page`, `anchor-text-diversity`), the Internal Linking results tab, and autopilot consumption. Unit suites, `tsc`, oxlint, and knip show no new debt; Playwright `audit-internal-linking` is 2/2. The full suite has one pre-existing env-gated live-API failure; `pnpm build` (client + SSR + `tsc`) is green (see `docs/plans/reports/2026-10-24-internal-linking-phase5-verification.md`).

**Input**: User description: "Phase 5 of the P1 SEO Intelligence master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` section 3.2 row 5): detectors over the `audit_links` graph of the latest completed audit - orphan candidates (coverage-gated), underlinked, deep, broken (exists), redirect chains (exists), non-indexable targets, anchor diversity, contextual suggestions from title/H1 (no unrelated link-count padding); evidence refs; UI section; autopilot consumption."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See where the internal link graph fails (Priority: P1)

A project owner opens a completed audit and can review the internal link graph as a first-class result: orphan candidates, underlinked pages, deep pages, broken internal links, redirect chains/loops, links to non-indexable targets, and anchor-text diversity. Every finding names the observed evidence (source URLs, target URL, inbound count, anchor sample, depth) and states whether the crawl was complete enough to support absence-based conclusions.

**Why this priority**: The audit already stores `audit_links` and `audit_pages`; surfacing the graph turns crawl data into actionable internal-linking work without a second crawl or a new provider.

**Independent Test**: Build a fixture audit with a start page, a hub, an orphan product, an underlinked blog post, a deep page, a broken link, a redirect chain, a noindex target, and repeated anchors. Assert the report and persisted issues match the expected findings, and that a truncated-crawl fixture suppresses only absence-based findings.

**Acceptance Scenarios**:

1. **Given** a completed audit, **When** the internal-linking report runs, **Then** it returns coverage state `complete`, summary counts, and evidence-backed findings for every detector that applies.
2. **Given** an audit whose crawl was not completed, **When** the report runs, **Then** coverage is `partial`, observed findings (broken links, redirects, links to noindex targets) still appear, and orphan/underlinked/anchor-diversity findings are suppressed with an explicit reason.
3. **Given** the same audit evaluated twice, **When** findings are persisted, **Then** deterministic issue rows are deduplicated (no duplicate issue per page/type/target).

### User Story 2 - Get contextual, non-padding link suggestions (Priority: P1)

For orphan and underlinked pages, the report suggests a small set of existing pages that could link to the target. Suggestions use observed page context (title and, when available, the observed Salla entity name derived from H1/structured data), page type, and URL path; they exclude pages that already link to the target, the target itself, utility pages, and pages that cannot pass link equity. The UI shows the shared terms as evidence.

**Why this priority**: "Add more internal links" is not actionable. A short, evidence-backed source list is the difference between a report and a task.

**Independent Test**: Fixture with a blog post sharing title terms with one hub and no terms with an unrelated page. Assert the hub is suggested, the unrelated page is not, and a page already linking to the target is excluded.

**Acceptance Scenarios**:

1. **Given** an underlinked target, **When** suggestions are computed, **Then** each suggestion names the source URL/title, a bounded relevance score, and the shared title/H1-derived terms.
2. **Given** a source that already links to the target or is the target itself, **When** suggestions are computed, **Then** it is never returned.
3. **Given** no source shares observed context, **When** suggestions are computed, **Then** the target returns an empty suggestion list rather than unrelated link-count padding.

### User Story 3 - Technical SEO autopilot consumes the findings (Priority: P2)

The existing technical SEO autopilot workflow sees the new internal-linking issue types through the stored issue counts and ranked technical work. No new workflow, provider, or parallel opportunity engine is introduced.

**Acceptance Scenarios**:

1. **Given** an audit with underlinked, orphan, deep, broken, and anchor-diversity issues, **When** the technical SEO workflow ranks work, **Then** those issue types are available to `rankIssues` with their severity and distinct-page counts.
2. **Given** the workflow output, **When** it describes a linking issue, **Then** it uses the stored issue evidence and does not invent link counts or rankings.

### Edge Cases

- Partial/truncated crawl: absence-based findings are suppressed; observed failures still surface.
- Small sites (fewer than 10 crawled pages): underlinked and anchor-diversity heuristics do not run, to avoid flagging normal small-site structure.
- Sitemap-only pages: orphan candidates are reported only when the crawl completed; `inSitemap` is included as evidence.
- Self-links (breadcrumbs, anchors) never count as inbound equity.
- Nofollow internal links are observed but excluded from anchor-diversity and underlinked equity counts.
- Redirect targets: redirect chain/loop findings reuse existing issue types; links to redirecting URLs are not double-reported as non-indexable.
- Canonicalized/noindex targets: links to them are reported on the source page with the reason and effective canonical.
- Arabic and mixed-script titles/anchors: tokenization is Unicode-aware; normalization does not strip non-Latin text.
- Duplicate anchors: identical anchor text is flagged only when there are at least 3 followed inbound links; all-empty anchors are also flagged.
- Query-parameter and trailing-slash variants remain distinct URLs, matching crawl identity.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST derive the internal-linking report from the latest stored audit's `audit_links` and `audit_pages` rows only. It MUST NOT fetch pages, call a paid provider, or start a second crawl.
- **FR-002**: The report MUST expose coverage: `complete` only when the audit finished a completed crawl; `partial` otherwise, with the audit status and a reason. Absence-based detectors (orphan, underlinked, anchor diversity) MUST NOT emit findings on a partial crawl.
- **FR-003**: Detectors MUST cover orphan candidates, underlinked pages, deep pages, broken internal links, redirect chains/loops, links to non-indexable targets, and anchor-text diversity. Existing issue types (`orphan-page`, `deep-page`, `broken-internal-link`, `redirect-chain`, `redirect-loop`) MUST be reused, not duplicated.
- **FR-004**: New persisted issue types MUST be `underlinked-page`, `link-to-noindex-page`, and `anchor-text-diversity`, registered in `src/shared/audit-issues.ts` with severity, explanation, and fix guidance.
- **FR-005**: The underlinked heuristic MUST be centralized and documented: indexable 2xx HTML target, in the sitemap, not the start URL, not a utility URL, crawl depth >= 2, and at most one distinct followed inbound source page. The report MUST call these "candidates", not confirmed defects.
- **FR-006**: The anchor-diversity heuristic MUST require at least three followed inbound internal links and either one distinct non-empty anchor or all-empty anchors. Anchor comparison MUST trim and case-fold Unicode text.
- **FR-007**: Links to non-indexable targets MUST be emitted on the source page when the target is a crawled 2xx HTML page that is `noindex` or canonicalized to another URL. Redirect targets are excluded (their own redirect issue applies).
- **FR-008**: Contextual suggestions MUST use observed title and, when available, the observed Salla entity name (the H1/structured-data-derived name), plus page type and URL path. They MUST exclude the target itself, existing inbound sources, utility pages, non-indexable/error sources, and pages with no shared observed terms. Each target MUST return at most 3 suggestions; the report MUST cap suggested targets at 200.
- **FR-009**: The report MUST include bounded evidence: coverage, summary counts, affected targets, inbound source samples, anchor samples, and suggestion shared terms. Output MUST be deterministic for identical stored inputs.
- **FR-010**: New issue persistence MUST run in the existing multipage finalize pass, use deterministic dedupe keys, and cap each new issue type (at most 2,000 rows per audit).
- **FR-011**: The report MUST be exposed through a project-scoped server function -> service -> repository path. Wrong-project access MUST fail with `NOT_FOUND` before repository reads; an authorization test MUST cover it.
- **FR-012**: The audit results UI MUST add an Internal Linking tab with loading, partial-coverage, empty, and populated states. It MUST show summary counts, affected targets, inbound counts, depth, and suggestions.
- **FR-013**: The existing technical SEO autopilot MUST consume the new issue types through `getIssueTypePageCountsForAudit` and `rankIssues`; no new workflow or parallel engine.
- **FR-014**: The crawler MUST persist the first observed non-empty H1 text (trimmed, capped) in `audit_pages.h1_text` in both dialects so suggestions can use real H1 context. Non-HTML, failed, and extraction-incomplete pages MUST store null; no H1 text is fabricated.
- **FR-015**: The schema change MUST include dual SQLite/Postgres migrations, schema parity, and local migration application. Existing audits without H1 text MUST still produce reports using title-only context.

### Non-Functional Requirements

- **NFR-001**: No new paid providers, no network reads at report time, and no render-time paid calls.
- **NFR-002**: Queries MUST be bounded: aggregate inbound counts in SQL, cap candidate targets/suggestions, and avoid loading all link edges for large audits.
- **NFR-003**: The report and issue details MUST be JSON-serializable, stable across runs, and safe for D1 row limits.
- **NFR-004**: All new modules MUST follow the existing flat, co-located test conventions and stay under lint file/function limits.

### Key Entities

- **LinkingPage**: stored page identity, URL, title, H1 text, page type, depth, sitemap/indexability state, status/fetch class.
- **InboundStats**: target URL, followed inbound link count, distinct source pages, distinct anchors, empty-anchor count, sample anchor.
- **LinkingFinding**: issue type, affected page, target URL, evidence, dedupe key.
- **LinkingSuggestion**: source page, target page, score, shared terms, reason.
- **InternalLinkingReport**: coverage, summary, affected targets, suggestions, evidence.

## Success Criteria _(mandatory)_

- **SC-001**: Fixture audits produce the expected orphan, underlinked, deep, broken, redirect, non-indexable-target, and anchor-diversity findings, with no duplicate issue rows.
- **SC-002**: A partial-crawl fixture suppresses orphan/underlinked/anchor-diversity findings and states why, while still reporting observed broken links/redirects.
- **SC-003**: Suggestions never include the target, existing inbound sources, utility pages, or unrelated pages; shared terms are visible.
- **SC-004**: New issue types appear in the technical SEO autopilot's ranked issue evidence without a new workflow.
- **SC-005**: Unit suites, schema parity, `tsc`, Prettier, oxlint, targeted/full Vitest, Playwright, and `pnpm build` are green (one known env-gated live-API failure excepted).

## Assumptions

- Phase 4's HEAD (`636ffec2`) is the verified baseline; this feature branches from it in `F:\SEO-Dashboard-worktrees\p1-internal-linking`.
- `audit_links` already stores one row per unique source/target edge with `anchor`, `isInternal`, and `isNofollow`; external edges are stored too but excluded from this feature.
- `audit_pages` already stores `crawlDepth` (null when not reached via links), `inSitemap`, `isIndexable`, canonical fields, page type, and extraction state.
- The existing `orphan-page`, `deep-page`, `broken-internal-link`, `redirect-chain`, and `redirect-loop` issue types remain the source of truth for those findings.
- The crawler can provide the first non-empty H1 text without an extra fetch; it is already parsed by `analyzeHtml`.
