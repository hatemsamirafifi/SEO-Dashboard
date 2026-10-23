# Tasks: SERP Clustering and Organic Snapshot Storage

**Branch**: `feat/p1-serp-clustering` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1 - Storage

- [x] T001 Add `serp_organic_snapshots` to `src/db/serp.schema.ts` and `src/db/pg/serp.schema.ts`; register in `src/db/schema.ts`, `src/db/d1/schema.ts`, `src/db/pg/schema.ts`.
- [x] T002 Generate migrations `drizzle/0070_*` and `drizzle-pg/0048_*`; verify the SQL and the journal/snapshot chain.
- [x] T003 Extend the schema parity test with an explicit index assertion for the new table.

## Phase 2 - Capture inside the rank check

- [x] T004 Add an optional top-10 `organicResults` list to `RankCheckResult` and `NormalizedSerpResult`.
- [x] T005 Fill the organic list in the DataForSEO live and queued paths and in the HTTP providers.
- [x] T006 Add `SerpOrganicSnapshotRepository.insertOrganicSnapshots` with deterministic ids and a unique conflict guard.
- [x] T007 Write the organic rows from the live and queued rank-check paths inside an isolated `try/catch` that never fails the rank check.
- [x] T008 Add capture tests: rows written with market/device/run, and a failed write leaving the rank snapshot intact.

## Phase 3 - Clustering service

- [x] T009 Add the pure clustering core (co-occurrence, threshold, bridge guard, deterministic ordering, coverage) with unit tests.
- [x] T010 Add `SerpClusteringService.getClusters` with project scoping, the freshness window, and market/device/engine compatibility.
- [x] T011 Add the coverage states (`ready`, `awaiting_data`, `insufficient_data`, `stale_data`) and the coverage percentage.

## Phase 4 - Opportunity emission

- [x] T012 Add the `serp_cluster_new_page` detector with injected thresholds and evidence.
- [x] T013 Register the detector (registry, dispatcher, thresholds, template, client types, boundary allowlists).
- [x] T014 Add the template copy with the forward-looking caveat and no causal verbs.

## Phase 5 - Surface and gates

- [x] T015 Add the project-scoped `getSerpClusters` server function and its authorization test.
- [x] T016 Add the client copy module with the coverage wording and the caveat, plus unit tests.
- [x] T017 Render the SERP clusters section in the rank-tracking config detail route.
- [x] T018 Run `pnpm types:check`, Prettier on changed files, `pnpm lint`, `pnpm knip`, `pnpm test:ci`, and `pnpm build`.
- [x] T019 Write the phase 7 verification report, mark the spec implemented, commit in atomic slices, and merge into the integration baseline.

## Dependencies

- T001-T003 before T004-T008.
- T006 before T007.
- T009-T011 before T012-T014.
- T012-T014 before T015-T017.
- T015-T018 before T019.
