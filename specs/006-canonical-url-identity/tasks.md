# Tasks: Canonical SEO URL Identity

**Input**: Design documents from `/specs/006-canonical-url-identity/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/canonical-identity.md

**Tests**: Included — Constitution P43–P45 requires regression tests for the identity invariants; quickstart.md defines the scenarios.

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification before touching the identity chain

- [x] T001 Verify baseline green: run `pnpm test ga4Normalize && pnpm test intelligence && pnpm test AnalyticsJoinService && pnpm test intelligence-boundaries` plus `pnpm types:check` before changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The full identity helper all stories consume; proven by the core fixture suite

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 Implement the full analytical identity in `src/shared/intelligence.ts` `canonicalUrl()`: host-context resolution for path-only rows (parse bare host from `projects.domain`-style input, strip `sc-domain:`/scheme, lowercase; no host context → path-scoped, never invented), scheme fold http→https, leading `www.` fold only (other subdomains + non-default ports preserved, hosts case-insensitive), path case preserved, duplicate slashes collapsed, non-root trailing slash folds away (root `/` preserved), fragments stripped, query strings excluded per existing policy, safe percent-encoding normalization (uppercase hex, unreserved decoded, non-ASCII preserved), blank/query-only → `(not set)` sentinel; keep delegating the strict path branch to `normalizeGa4LandingPage` in `src/shared/ga4.ts` — do NOT modify `normalizeGa4LandingPage`
- [x] T003 [P] Write the identity fixture suite in `src/shared/intelligence.test.ts` covering every binding pair from `contracts/canonical-identity.md`: MUST-JOIN (`http://www.example.com/page` ≡ `https://example.com/page/` ≡ path-only `/page` + host `example.com`; `/blog` ≡ `/blog/`; `/blog/post` ≡ `/blog/post/`; `/` stays root; `/blog?a=1` ≡ `/blog/?a=1`; Arabic path ≡ its percent-encoded form) and MUST-NOT-JOIN (`blog.example.com/page` vs `example.com/page`; `example.com:8443/page` vs `example.com/page`; `/Blog` vs `/blog`; `example.com/x` vs `other.com/x`; `(not set)` vs anything), plus two-run determinism and pass-through behavior for malformed non-URL/non-path input
- [x] T004 [P] Add strict-path regression guard in `src/shared/ga4Normalize.test.ts` asserting `normalizeGa4LandingPage` semantics are byte-identical to pre-change behavior (slash preserved, case preserved, `(not set)` sentinel) — proves GA4 sync storage grain untouched

**Checkpoint**: Foundation ready — identity helper + fixture suite green; user stories can begin in parallel

---

## Phase 3: User Story 1 - Same page from different sources joins as one (Priority: P1) ⭐ MVP

**Goal**: Cross-source joins group alias/slash variants of one page into a single joined row; distinct pages never merge

**Independent Test**: Seed mixed-source rows (GA4 path-only + GSC/rank full URLs for one host), run the join agreement test, verify same-page rows join with per-source presence and distinct pages stay distinct

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T005 [P] [US1] Cross-consumer agreement test in `src/server/features/intelligence/services/AnalyticsJoinService.test.ts`: GA4 stored `landingPage` values, GSC URLs, and rank URLs resolve to one join key for the same logical page (www/http/slash variants) and distinct keys for distinct pages; phantom-duplicate count is zero over the seeded corpus

### Implementation for User Story 1

- [x] T006 [US1] Extend `joinUrlEvidence` in `src/server/features/intelligence/services/AnalyticsJoinService.ts` to pass the project host context into `canonicalUrl` for path-only GA4 rows (full URLs unchanged), preserving the pure pre-fetched-rows-in design (no repository imports)
- [x] T007 [US1] Verify every detector/entity-key call site of `canonicalUrl` (`cannibalization.ts`, `contentDecay.ts`, `technicalOnImportantPage.ts`, `src/shared/intelligence.ts` entity-key builders) compiles and behaves consistently with the new identity; adjust call sites only where host context must flow in, changing no detector semantics

**Checkpoint**: US1 independently testable — mixed-source corpus joins to one row per physical page

---

## Phase 4: User Story 2 - One shared identity, consumed everywhere (Priority: P2)

**Goal**: No parallel canonicalizer can exist; all analytical consumers route through the single helper, proven by a guard test

**Independent Test**: Run the extended boundary guard; deliberately introduce a scratch bypass and verify the guard fails; remove it and verify green

### Implementation for User Story 2

- [x] T008 [US2] Extend `src/server/features/intelligence/intelligence-boundaries.test.ts` with the identity guard per research Decision 6: listed analytical consumers (`AnalyticsJoinService.ts`, detector files using `canonicalUrl`, `src/shared/intelligence.ts` entity-key builders) must import the single identity helper; no production file outside the allowlist (`src/shared/intelligence.ts`, `src/shared/ga4.ts`, `src/server/lib/audit/url-utils.ts` strict exception, tests) may define www/protocol-folding helpers (banned patterns: `replace(/^www\./`, protocol-fold assignment on parsed URLs)
- [x] T009 [US2] Verify strict crawl identity untouched: run `pnpm test url-utils` + `pnpm test lighthouse` — `canonicalUrlKey` (`src/server/lib/audit/url-utils.ts:55`) slash-preservation behavior and Lighthouse start-URL matching unchanged; add a comment cross-referencing the documented P24 exception if absent

**Checkpoint**: US2 independently testable — guard green, audit behavior byte-identical

---

## Phase 5: User Story 3 - Migration without corrupted history (Priority: P3)

**Goal**: Superseded-keyed opportunities retire through the existing lifecycle; no history rewritten; project isolation holds

**Independent Test**: Seed a project with old-policy-keyed opportunities + stored rows, run two scans, verify no duplicates and retirement via miss/stale lifecycle; verify two projects sharing a path on different domains never merge

### Tests for User Story 3

- [x] T010 [P] [US3] Lifecycle test in `src/server/features/intelligence/services/materializeFinding.test.ts` (mirroring the `striking_distance` lifecycle pattern): a finding emitted under the new identity while an old-key row exists creates a new opportunity; the old-key row misses scans and retires via `STALE_AFTER_MISSES = 3` — no duplicate active rows for one logical page; cross-project isolation asserted

### Implementation for User Story 3

- [x] T011 [US3] Verify scan-time re-derivation is deterministic end-to-end: run the full detector suite over seeded snapshots and confirm recomputed identity is identical across repeated runs; record the G1 gate as passed (fixture suite + guard + agreement green) in the spec status per `contracts/canonical-identity.md`

**Checkpoint**: All user stories independently functional; G1 recordable

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T012 Run `pnpm types:check && pnpm oxlint` and fix any violations
- [X] T013 Run quickstart.md validation scenarios end-to-end (fixture determinism, base semantics unchanged, agreement, guard, no-history-corruption upgrade)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies — start immediately
- **Phase 2 Foundational**: Depends on T001 — BLOCKS all user stories
- **US1 (Phase 3)**: After T002–T004; US2/US3 can proceed in parallel afterward (US2 touches only the guard file; US3 touches only materializer tests + verification)
- **Polish (Phase 6)**: After all stories

### Parallel Opportunities

- T003, T004 parallel (different files)
- T005 parallel with T008/T010 (different test files)
- US2 and US3 fully parallel once US1 lands (no shared files)

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 → T002–T004 → T005–T007 → STOP and VALIDATE (agreement test green, joins dedupe phantom pages)
2. US1 alone already delivers the G1 value; US2 (guard) and US3 (lifecycle verification) harden it

### Incremental Delivery

US1 (joins) → US2 (guard) → US3 (history safety) — each independently verifiable via quickstart scenarios 3, 4, 5.

## Notes

- No schema changes, no migrations, no new files outside the listed test/helper extensions — P50.
- Never modify `normalizeGa4LandingPage` semantics or audit `url-utils.ts` behavior — those changes are out of scope and guard-tested.
