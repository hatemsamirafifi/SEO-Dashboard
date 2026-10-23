# Implementation Plan: SERP Clustering and Organic Snapshot Storage

**Branch**: `feat/p1-serp-clustering` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/019-serp-clustering/spec.md`

## Summary

Store the organic results that the rank check already bought, cluster the pages
that keep appearing together inside one market and device, and emit an evidence-
backed opportunity when a cluster contains a page the project does not own. The
storage is a new dual-dialect table; the capture happens inside the existing rank
check with full failure isolation; the clustering is a pure service over stored
rows; the surface is a section in the existing rank-tracking detail view.

## Technical Context

- **Language/Version**: TypeScript, Vite build, Vitest, React 19, TanStack Router/Query/Start.
- **Primary Dependencies**:
  - `src/server/lib/dataforseo/serp.ts` - the provider responses that already carry the organic list.
  - `src/server/features/serp/types.ts` - `SerpOrganicResult`, `NormalizedSerpResult`.
  - `src/server/workflows/rankCheckPaths.ts` - the live and queued rank-check write paths.
  - `src/db/app.schema.ts` + `src/db/pg/app.schema.ts` - rank-tracking tables.
  - `src/server/features/intelligence/detectors/*` - detector, registry, thresholds, template.
  - `src/client/features/rank-tracking/*` - the rank-tracking detail surface.
- **Storage**: new `serp_organic_snapshots` table in both dialects, migrations
  `drizzle/0070_*` and `drizzle-pg/0048_*`. No other schema change.
- **Testing**: Vitest co-located unit tests; schema parity; `pnpm test:ci`, `pnpm ci:check`, `pnpm build`.
- **Target Platform**: Cloudflare Workers (D1/Workflows) and Postgres self-host.
- **Performance Goals**: at most ten organic rows per keyword and device per run;
  the clustering input is bounded by the freshness window and the tracked keyword set.
- **Constraints**: no new paid provider call; the organic write MUST be isolated from
  the rank check; observational prose; dual-dialect parity; 400-line file limit.
- **Scale/Scope**: one project, one market and device at a time; a cluster needs
  three or more co-occurring keywords.

## Constitution Check

- **Project scope / authorization**: no new provider; the surface reuses the
  existing project-scoped rank-tracking and opportunity routes.
- **Dual dialect parity**: new table in both dialects, explicit index assertions.
- **Observed-only**: organic rows store what the provider returned; the
  completeness status distinguishes a full top-10 set from a partial one.
- **No competing architecture**: reuse the existing provider result types, the
  detector/materializer path, and the rank-tracking detail surface.
- **Truthfulness**: the cluster analysis is labelled forward-looking; coverage
  states never claim "no clusters" when nothing was observed.
- **Bounded cost**: no new calls, capped rows per keyword and device.
- **Testing**: capture isolation, cluster threshold, bridge guard, market
  compatibility, coverage states, and no-inference negatives.

## Design

### 1. Storage

- `src/db/serp.schema.ts` and `src/db/pg/serp.schema.ts`: `serp_organic_snapshots`
  with keyword, engine, location code and name, language, device, position, URL,
  normalized URL, title, domain, provider, run id, config id, project id,
  tracking keyword id, observed timestamp, completeness status, and timestamps.
- Indexes: `project + location + language + device`, `project + observed_at`,
  `run_id`, and a unique constraint on
  `(run_id, tracking_keyword_id, device, position)`.
- Registered in `src/db/schema.ts`, `src/db/d1/schema.ts`, `src/db/pg/schema.ts`.
- Migrations `0070` (SQLite) and `0048` (Postgres) generated with
  `pnpm db:generate:d1` / `pnpm db:generate:pg`.

### 2. Capture (inside the rank check)

- `SerpOrganicResult` (already defined) is the capture contract.
- `RankCheckResult` and `NormalizedSerpResult` gain an optional
  `organicResults` list (top-10, observed only). The DataForSEO live and queued
  paths fill it from the parsed items; the HTTP providers fill it from the organic
  items they already parse.
- `rankCheckPaths.ts` writes the rows for fulfilled results through
  `SerpOrganicSnapshotRepository.insertOrganicSnapshots`, wrapped in its own
  `try/catch`: a failure is reported (warning + run-level note) and never changes
  the rank snapshot, the run status, or the provider failure semantics.

### 3. Clustering service

- `src/server/features/serp/clustering/`:
  - `SerpOrganicSnapshotRepository` (write + bounded reads).
  - `SerpClusteringService.getClusters({projectId, configId, device})`:
    project-scoped, reads the stored rows inside the freshness window, groups by
    keyword, builds the page co-occurrence graph, and returns the clusters plus
    the coverage state and percentage.
  - Pure core in `clusterCore.ts`: threshold (>= 3 co-occurring keywords), bridge
    guard, deterministic ordering, and the coverage computation.
- Compatibility: only rows with the same engine, location, language, and device
  are clustered together.

### 4. Opportunity emission

- New detector key `serp_cluster_new_page` with `requiredSources: ["rank"]`,
  coverage grain `serp_organic`, injected thresholds, and a template whose copy is
  a review suggestion carrying the forward-looking caveat.
- Registered in the detector registry, the input dispatcher, the thresholds, the
  template map, the client opportunity types, and the boundary allowlists.

### 5. Surface

- `src/serverFunctions/serpClustering.ts`: project-scoped server function
  returning the clusters and the coverage state.
- `src/client/features/serp-clustering/serpClusteringCopy.ts`: labels, coverage
  wording, and the forward-looking caveat (unit tested).
- A "SERP clusters" section in the existing rank-tracking config detail route.

## Tasks

See [tasks.md](./tasks.md).

## Verification

1. `pnpm types:check`
2. `pnpm exec prettier --check` on changed files
3. `pnpm lint`
4. Targeted Vitest: capture, clustering core, service, detector, copy, parity
5. `pnpm test:ci`
6. `pnpm knip`
7. `pnpm build`

## Risks

- The provider organic list is capped by `stop_crawl_on_match`; the completeness
  status records a partial set instead of assuming a full top-10.
- The clustering threshold is a reasoned prior and is injected, so the first
  production scans can recalibrate it without a code-path change.
- The extra write adds rows to D1; the per-keyword cap of ten keeps the volume
  proportional to the rank checks the project already runs.
