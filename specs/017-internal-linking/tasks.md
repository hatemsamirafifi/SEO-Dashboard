# Tasks: Internal Linking Opportunities Engine

**Branch**: `feat/p1-internal-linking` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1 - Schema and crawl context

- [x] T001 Add `h1Text` to `auditPages` in `src/db/audit.schema.ts` and `src/db/pg/audit.schema.ts`.
- [x] T002 Generate and trim migrations 0069 (SQLite) and 0047 (Postgres); repair snapshot chain; update journals.
- [x] T003 Add `h1Text` to `CrawledPageResult`; populate first non-empty H1 (cap 500) in `crawlPage`; null for partial/non-HTML.
- [x] T004 Persist `h1Text` in `insertCrawledBatch`; update all `CrawledPageResult` fixtures and E2E page fixture.
- [x] T005 Run `schema-parity.test.ts` and the crawler helper tests.

## Phase 2 - Linking core

- [x] T006 Create `src/server/lib/audit/linking/types.ts`.
- [x] T007 Create `analyze.ts` with coverage, thresholds, findings, tokenization, suggestions.
- [x] T008 Add `analyze.test.ts` covering complete/partial coverage, underlinked, anchor diversity, non-indexable targets, suggestions, Arabic tokens, and dedupe.
- [x] T009 Add new issue descriptors to `src/shared/audit-issues.ts`.
- [x] T010 Create `linkingQueries.ts` with bounded page, inbound-stat, candidate-edge, and issue queries.
- [x] T011 Extend `runMultipageChecks` to append new findings with caps and coverage gates.
- [x] T012 Add pure issue-builder tests and, where practical, a DB-backed multipage test.

## Phase 3 - Report and API

- [x] T013 Create `InternalLinkingService.getReport` with project-scoped audit lookup.
- [x] T014 Add `getInternalLinkingReport` server function with validator and E2E fixture fallback.
- [x] T015 Extend `audit.authorization.test.ts` with the new server function.
- [x] T016 Add report service tests for NOT_FOUND and bounded output.

## Phase 4 - UI and E2E

- [x] T017 Add `"linking"` to `auditTabs` and route/ResultsView tab types.
- [x] T018 Create `InternalLinkingView.tsx` with coverage, summary, targets, suggestions, loading/empty/error states.
- [x] T019 Wire the tab into `ResultsView`; hide export for linking.
- [x] T020 Add `audit-linking-fixtures.ts` and `audit-internal-linking.spec.ts`.
- [x] T021 Run Playwright and fix UI issues.

## Phase 5 - Autopilot and gates

- [x] T022 Add autopilot ranking test for new issue types; verify no workflow change is needed.
- [x] T023 Run `pnpm types:check`, Prettier, oxlint, targeted Vitest.
- [x] T024 Run `pnpm test:ci`, `pnpm ci:check`, `pnpm build`, `pnpm knip`.
- [x] T025 Commit in atomic slices with `lrc review --skip` before each commit.

## Dependencies

- T001-T005 before T006-T012 (H1 context and schema).
- T006-T010 before T011-T016.
- T013-T016 before T017-T021.
- T017-T021 before T022-T025.
