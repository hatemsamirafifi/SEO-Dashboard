# Data Model: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Companion docs**: [research.md](./research.md) (decisions R1–R4), [contracts/](./contracts/)

All schema changes are additive, D1+PG mirrored, and parity-tested in the same change (P3–P5).

## New entity: `ga4_project_goals` (table)

One row per user-defined conversion goal, scoped to a project.

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text PK | generated id (existing id conventions) |
| `project_id` | text NOT NULL | FK → `projects.id` ON DELETE CASCADE |
| `organization_id` | text NOT NULL | FK → `organization.id` ON DELETE CASCADE (mirrors `ga4_connections`) |
| `name` | text NOT NULL | display name; unique per project among **active** goals (partial unique index, mirrors `opportunities_active_key_uidx` pattern) |
| `event_name` | text NOT NULL | binds to `ga4_daily_events.event_name` values |
| `match_key_event_only` | boolean NOT NULL default false | when true, goal counts only rows with `isKeyEvent = true` |
| `archived_at` | text NULL | NULL = active; non-NULL = archived (timestamp) |
| `created_at` / `updated_at` | text NOT NULL | defaults `current_timestamp` (existing `ga4Timestamps` block) |

**Indexes**:
- `uniqueIndex ga4_goals_project_name_active_uidx ON (project_id, name) WHERE archived_at IS NULL`
  (partial — archived names are reusable, active names unique)
- `index ga4_goals_project_idx ON (project_id)`

**Validation rules (Zod, trust boundary `src/types/schemas/ga4.ts`)**:
- `name`: trimmed, 1–100 chars; `event_name`: trimmed, 1–100 chars (matches GA4 event-name length norms);
- create/update/archive schemas `.strict()`; every operation carries `projectId` + project-context
  middleware (P39);
- active-goal count per project capped (default 20, service-enforced — loud validation error at the cap).

**State transitions**: active ⇄ archived only. Archive is soft (sets `archived_at`); archived goals keep
historical references (findings/evidence cite `goalId` + frozen name snapshot in evidence, so archive
never corrupts history). Delete is NOT exposed (historical evidence integrity, mirrors P31 spirit).

## Extended reads (no new tables)

### Goal-scoped conversions (derived, not stored)

Computed at query time from `ga4_daily_events`:

```text
goalConversions(projectId, goalId, windowFrom, windowTo) =
  sum(event_count) WHERE project_id/property_id match
  AND event_name = goal.event_name
  AND (NOT goal.match_key_event_only OR is_key_event = true)
  AND date ∈ SUCCESS_*-covered event dates        -- covered-dates subquery precedent
```

`event_count` is additive per (project, property, date, event) — window sums are valid (P23). Users are
never summed. Per-window `coveredDates/totalDates` feeds the existing `AnalyticsCoverage` state so
no-data vs failed render distinctly (P9/P21/P30).

### Organic page join (pure extension of `AnalyticsJoinService.joinUrlEvidence`)

The existing pure function's row model gains additive fields (contract in
[contracts/organic-join.md](./contracts/organic-join.md)):

```text
JoinGa4Page (extended):
  landingPage, currentSessions, previousSessions        (existing)
  currentEngagedSessions, previousEngagedSessions      (new, additive)
  currentGoalConversions, previousGoalConversions      (new, additive; per goal filter)

JoinedUrlRow (extended):
  + ga4Engagement: { currentEngagedRate, previousEngagedRate, currentRate, previousRate } | null
  + ga4GoalConversions: { current, previous } | null     (null = no GA4 coverage, never 0)
```

Join key remains exclusively `canonicalUrl(value, hostContext)` (006 contract; P24/G1). Sources absent
for a page keep `null` metrics + `present.* = false` — the existing pattern
(`AnalyticsJoinService.ts:59-84`), extended, not replaced.

### Detector findings (existing `FindingDraft` model, two new detectorKeys)

| Property | `conversion_drop` (C2b) | `engagement_drop` (C2c) |
| --- | --- | --- |
| `detectorKey` | `conversion_drop` | `engagement_drop` |
| version | 1 | 1 |
| entityKey | canonical page URL | canonical page URL |
| requiredSources | `["ga4"]` | `["ga4"]` |
| optionalCorroborators | `["rank", "gsc"]` | `["rank", "gsc"]` |
| coverage | ga4 events grain + landing grain, ≥0.8 | ga4 landing grain, ≥0.8 |
| thresholds | R3 table (minWindowDays 28, minCoverageRatio 0.8, minEventsPerWindow 10, declineRatio 0.3) | R3 table (28, 0.8, minSessionsPerWindow 100, declineRatio 0.25, rankHoldRequired) |
| evidence sourceRefs | `ga4Keys[]` (deterministic fact ids), `goalId`+`goalName` in metrics | `ga4Keys[]` |
| materializer template | `OPPORTUNITY_TEMPLATES.conversion_drop` (type `ga4_conversion`) — activates `conversionSignal` impact factor | `OPPORTUNITY_TEMPLATES.engagement_drop` (type `ga4_engagement`) |

Threshold registry: `DEFAULT_DETECTOR_THRESHOLDS` gains both entries; `THRESHOLD_VERSION` 2 → 3
(no production artifacts to migrate — precedent in file header).

### Opportunities list filters (schema extension, no storage change)

`listOpportunitiesSchema` extends to:

```text
{
  projectId,
  status?, type?,                       (existing)
  page?: string,                       (equality on opportunities.page — indexed)
  keyword?: string,                    (equality on opportunities.keyword — indexed)
  source?: string,                     (sourcesJson contains value)
  priority?: enum("critical"|"high"|"medium"|"low"),
  statuses?: OpportunityStatus[],      (multi-value OR within AND-composition)
  types?: string[],
  priorities?: string[],
}
```

All dimensions AND-compose; arrays are OR within their dimension. Repository composes over the four
existing indexes (`opportunities.schema.ts:78-96`); no new indexes (P50). Empty filter = "all"
(existing convention). Client keeps `search` as its only local refinement.

## Entity relationships

```text
projects 1───N ga4_project_goals            (cascade on project delete)
projects 1───N ga4_connections              (existing; goals reference events textually, not by FK —
                                            event_name is a value binding, not a row relation;
                                            deliberate: GA4 event vocabulary is external data)
ga4_project_goals ──(goalId snapshot in evidence)──▶ findings/opportunities (frozen text refs)
ga4_daily_events ──(query-time sum)──▶ goal conversions (derived, never stored)
GA4 ∪ GSC ∪ rank grains ──(canonicalUrl)──▶ JoinedUrlRow (computed, never persisted: §9.6 "nothing persisted")
detectors ──▶ FindingDraft ──▶ materializer ──▶ opportunities + opportunity_events (existing chain)
```

## Migration notes

- One additive migration per dialect: `drizzle/00XX_*.sql` (SQLite) + `drizzle-pg/00XX_*.sql` —
  `CREATE TABLE ga4_project_goals` + the two indexes only. No backfill (new table, empty at birth — P5).
- `schema-parity.test.ts` gains the table to the parity list; `ga4Migration.test.ts` gains the
  table-name coverage entry (both files already enumerate `ga4_daily_events` et al — same pattern).