# Data Model — spec 011: SERP Features Normalization + Dashboard Intelligence UI

Phase 1 design artifact. **No new database tables.** This package introduces one pure view-model
derivation and one extended shared mapping; all persistence contracts already exist.

## 1. Stored inputs (existing — consumed, never redefined)

### SerpSnapshot / SerpFeatureSet (frozen spec-003 contract — hard gate G4)

Defined in `src/server/features/serp/types.ts`. Relevant shape:

- `SerpSnapshot.features: SerpFeatureSet` — `.strict()` object; **only observed families present
  as keys**; absent families are `undefined`.
- Ten families (fixed by P14): `featuredResult`, `peopleAlsoAsk { items: { question, url?,
  placement? }[] }`, `relatedSearches { items: string[] }`, `localPack { items: { title, url?,
  domain?, address?, rating?, reviewCount? }[] }`, `images { items: { url, title?, domain? }[] }`,
  `videos { items: { url, title?, domain? }[] }`, `shopping { items: { title, url?, domain?,
  price? }[] }`, `news { items: { title, url?, domain?, sourceName?, publishedAt? }[] }`,
  `knowledgeGraph { title, url?, domain?, description? }`, `sitelinks { items: { url, domain?,
  title? }[] }`.
- Unknown families cannot exist past ingestion validation — therefore the presentation layer can
  never see an unmapped family at runtime; the FR-005 "drop safely" guarantee is enforced
  upstream by `.strict()` and stays tested there (`serpSnapshot.test.ts`), with a defensive
  unknown-key sweep in the derivation for belt-and-braces.

### Competitive metrics (frozen spec-007 contract)

Per top-10 result row: `status ∈ available | partial | unavailable | failed` plus metric fields.
Used only to render degradation explicitly; never gates base SERP or feature rendering.

### Dashboard stored-rollup inputs (spec 001)

`DashboardService.getIntelligenceOverview` returns eight `OverviewSection<T>` values —
`seoPerformance`, `searchVisibility`, `trafficEngagement`, `conversions`, `opportunities`,
`technicalHealth`, `backlinks`, `recentChanges` — each `{ state, coverage: CoverageNote,
metrics: T | null }`. Metrics come from stored rollups/findings only (P29). Unchanged.

## 2. New view-model: SerpFeatureBlock (presentation only)

Derived by `featurePresentation.ts`. One block per **observed** family. Not persisted.

| Field | Type | Notes |
| --- | --- | --- |
| `family` | one of the ten frozen family keys | provenance of the block |
| `label` | string | single shared display label (fixes today's split vocabulary in `RankTrackingTableParts.tsx` vs the frozen keys) |
| `order` | number | deterministic render order; placement-honored for PAA (R3), family default otherwise |
| `items` | readonly array of the family's item shape | passed through from the snapshot, never re-shaped (no fabricated fields) |
| `placement` | number \| null | recorded placement where the contract carries it (PAA); `null` = fallback position (R3) |

Validation rules:

- **V1 (no fabrication)**: output contains exactly one block per key present on the input object;
  keys absent on the input produce no block. Implemented by iterating present keys, never a fixed
  family list.
- **V2 (pass-through fidelity)**: block `items` are the snapshot's items unchanged except for a
  defensive dedupe of exact-duplicate entries; every dedupe emits a trace/observational note
  (spec edge case — logged, not silent).
- **V3 (placement policy)**: PAA blocks carry `placement`; rendering positions them per R3 and
  never inserts them into the numbered organic list.
- **V4 (vocabulary fix)**: the block labels map 1:1 onto the frozen family keys; any legacy chip
  rendering (`featured_snippet`, `knowledge_panel`, `top_stories`, `ai_overview`) consolidates
  onto the frozen families (mapping recorded in contracts/serp-feature-presentation.md).

## 3. Extended mapping: unified 11-state section model (A2)

### State enumeration (existing — kept)

`DASHBOARD_SECTION_STATES` in `src/shared/intelligence.ts` (11 states, verbatim P30):
`loading, ready, empty, not_connected, no_data, partial, stale, api_failed, permission_failed,
sync_running, sync_failed`.

### Mapping input (extended)

`MapStoredSectionStateInput` = existing `mapStoredSectionState` input plus:

| Field | Type | Default | Feeds state |
| --- | --- | --- | --- |
| `connected` | boolean | — | `not_connected` |
| `loading` | boolean | `false` | `loading` |
| `permissionDenied` | boolean | `false` | `permission_failed` |
| `syncRunning` | boolean | — | `sync_running` |
| `syncFailed` | boolean | — | `sync_failed` |
| `readFailed` | boolean | `false` | `api_failed` (deterministic path; `safeSection` remains the exception backstop) |
| `hasCurrent` | boolean | — | data availability |
| `hasPrevious` | boolean | — | `partial` vs `ready` |
| `hasItems` | boolean \| null | `null` | list sections only: `empty` vs data-ready |
| `stale` | boolean | `false` | `stale` |

### Deterministic precedence (fixed, documented, test-covered)

First match wins:

1. `loading` → `loading`
2. `!connected` → `not_connected`
3. `permissionDenied` → `permission_failed`
4. `!hasCurrent && syncRunning` → `sync_running` (with current coverage the section keeps its
   data state and annotates via `coverage.detail` — preserved spec-001 behavior, never hidden)
5. `!hasCurrent && syncFailed` → `sync_failed` (same scoping rationale)
6. `readFailed` → `api_failed`
7. `!hasCurrent && !hasPrevious` → `no_data`
8. `hasItems === false` → `empty`
9. `stale` → `stale`
10. `!hasPrevious` → `partial`
11. otherwise → `ready`

State transitions: none (state is derived per read, not accumulated). Each
`DashboardService.get*Section` computes its input flags from its stored reads and calls the
mapper; no section sets `state:` directly anymore. `safeSection` stays as the exception path and
maps to the same `api_failed` state — two producers, one state vocabulary.

### Section × input obligations

| Section | connectivity | data checks | failure inputs | list item check |
| --- | --- | --- | --- | --- |
| seoPerformance | GSC connected | window coverage current/previous | syncRunning/syncFailed from GSC sync status | n/a |
| searchVisibility | rank tracking configured | latest stored rank snapshot | — | `empty` when zero tracked keywords |
| trafficEngagement, conversions | GA4 connected | window coverage | syncRunning/syncFailed from GA4 sync status | n/a |
| opportunities | always connected (internal) | open-opportunity query ok | readFailed via `safeSection` | `empty` when zero open |
| technicalHealth | audit configured | latest audit snapshot; `stale` beyond 30d | readFailed | n/a |
| backlinks | provider configured *and* snapshot exists for domain | snapshot presence; `stale` | readFailed | n/a |
| recentChanges | always connected (internal) | insights read ok | readFailed | `empty` when zero items |

## 4. Mobile card view model

`SerpResultCardRow` = `{ position, title, url, domain, summary: string | null, featureRefs:
string[] , metrics: CompetitiveMetrics | null, familyBlocksInSlot: SerpFeatureBlock[] }` — a
pure composition of the stored snapshot rows + the derived blocks. Card renders
position/result/summary always; metrics and feature detail behind expansion. Same source data as
the desktop dense view; no second fetch, no second state path.
