# Research: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Method**: live-repository inspection (P48) — every claim below cites the file/line evidence it rests on.
Resolves the four open decisions flagged in [plan.md](./plan.md) Technical Context.

---

## R1 — Goal definition model (what a goal binds to)

**Decision**: A goal binds to stored GA4 event rows by `eventName` **plus** an `isKeyEvent` requirement flag
(`matchKeyEventOnly`). Goal-scoped conversion counts are computed by filtering `ga4_daily_events` on
`event_name = goal.eventName` (and `isKeyEvent = true` when required) and summing `event_count` — an
additive metric, so window sums are valid (P23 satisfied: event counts are additive; users are never
touched).

**Rationale (repository evidence)**:
- `ga4_daily_events` already stores exactly this shape: `eventName` (notNull), `eventCount`,
  `isKeyEvent` (`src/db/ga4.schema.ts:187-220`; PG mirror `src/db/pg/ga4.schema.ts:176-204`), with the
  upsert key `(projectId, propertyId, date, eventName)` and query index
  `(projectId, eventName, date)` — the exact access pattern goal filtering needs, already indexed.
- The read path precedent exists: `getEventGroups(projectId, propertyId, from, to, { limit, keyEventsOnly })`
  filters by `isKeyEvent = true` and groups by `eventName` over SUCCESS_*-covered dates only, with the
  SQLite/PG boolean-parity `max(case when ...)` aggregation pattern
  (`src/server/features/ga4/repositories/Ga4SyncRepository.ts:1083-1124`). Goal-scoped reads reuse this
  covered-dates subquery pattern; a goal is a persisted eventName filter with a display name.
- The schema comment at `src/types/schemas/ga4.ts:79` records "Goal selection ... stay deferred per §22"
  — this package is the planned un-deferral; the `keyEventsOnly` parameter on the conversions read is the
  seam it plugs into.
- Why not key-event-only goals without eventName: GA4 key events are event-scoped; a project may mark
  several distinct events as key events, and the user needs to choose which one is "the goal" for
  filtering. `keyEventsOnly` alone cannot express that choice.

**Alternatives considered**:
- *Goal = arbitrary GA4 Data API dimensions/expressions*: rejected — requires live API reads at render
  (violates G10/P29) and new fetch paths; the spec assumption says "no new GA4 API dimensions are fetched".
- *Goal = session-scoped*: rejected — sessions are not conversions; `ga4_daily_events` is the only
  conversion-shaped stored grain.
- *Separate `ga4_goal_conversions` synced table*: rejected — duplicates data already queryable from
  `ga4_daily_events` (P50 scope discipline; additive-only schema law keeps migrations minimal).

**Goal cap**: bounded per project (default 20 active goals, configurable constant in the service) to keep
filter lists and detector fan-out bounded — mirrors the bounded-cardinality convention of spec 002.

---

## R2 — Engagement metric for the C2c engagement-drop detector

**Decision**: Per-page engagement is measured by **engaged sessions** (`engagedSessions`) with
**engagement rate** (`engagedSessions / sessions`) as the normalized comparison metric, computed from
`ga4_daily_landing_pages` sums per canonical page (both additive per page per day; the rate derives from
summed numerators/denominators at query time — the exact `ratioOf` precedent at
`AnalyticsService.ts:81-83`, never averaging daily rates).

**Rationale (repository evidence)**:
- `ga4_daily_landing_pages` carries per-page `sessions`, `engagedSessions`, `userEngagementDuration`,
  `screenPageViews` (`Ga4SyncRepository.ts:1046-1071` groups/returns exactly these), and
  `getLandingGroups` already demonstrates per-page grouping over covered dates with the
  `getPeriodUsers`-guarded user semantics. No new fetch shape is required — the detector's fetcher
  reuses the landing-pages read with both windows.
- `AnalyticsService` already models engagement-rate and avg-engagement-time as ratio-of-sums
  (`engagementRateOf`, `avgEngagementTimeOf`, lines 85-97) — the detector reuses the same
  numerator/denominator semantics for window comparison instead of inventing a metric.
- Spec C2c says "engagement collapsed **while ranking held**": the existing pure join
  `AnalyticsJoinService.joinUrlEvidence` already carries per-page `rankWorsened` plus GSC clicks and
  GA4 sessions current/previous (`AnalyticsJoinService.ts:12-28`), with `present.{gsc,ga4,rank}`
  coverage booleans (lines 80-84) — the rank-held corroboration gate already exists as data. The
  engagement detector emits only when `present.ga4 && present.rank && !rankWorsened` (or GSC-only
  corroboration when rank absent → capped confidence via `partialData`), reusing the join rather than
  building one.
- Engagement-rate (not raw engaged sessions) is the comparison basis so shorter/longer windows and
  page-volume differences normalize — consistent with the spec edge case "different numbers of days".
  Window coverage still gates via `expectedDays`/`days` exactly as `ga4OrganicChange` does
  (`ga4OrganicChange.ts:19-23,104-114`).

**Alternatives considered**:
- *`userEngagementDuration` per session*: viable but weaker signal-to-noise (long-tail outliers);
  engaged-session ratio is the standard GA4 surface users recognize.
- *Bounce-rate-like inverse*: not stored in the grains; fabricating it violates P47.
- *Site-level engagement* (not per-page): that's the existing `ga4_organic_change` shape
  (`ga4OrganicChange.ts` is site-level by design); C2c is explicitly page-scoped.

---

## R3 — Detector threshold defaults and evidence shape (C2b conversion / C2c engagement)

**Decisions** (following the injected-threshold convention `THRESHOLD_VERSION`-versioned in
`src/shared/intelligence-thresholds.ts:1-24` — "thresholds are injected into detectors, never
hardcoded; every threshold applied is echoed in finding evidence"):

| Threshold | conversion_drop (C2b) | engagement_drop (C2c) | Basis |
| --- | --- | --- | --- |
| `minWindowDays` | 28 | 28 | conversion/engagement shifts need ≥ a monthly window to avoid weekly churn; matches `content_decay`/`low_ctr_query` priors |
| `minCoverageRatio` | 0.8 | 0.8 | house standard across all windowed detectors |
| `minEventsPerWindow` (floor) | 10 | — | absolute conversions floor: below this the drop is noise (mirrors `minImpressions: 100` role) |
| `declineRatio` | 0.3 | 0.25 | conversion drops of ≥30% / engagement-rate drops of ≥25% are actionable priors; near-miss logging (per header comment) calibrates without code-path changes |
| `minSessionsPerWindow` | — | 100 | engagement-rate denominator floor before a ratio decline is meaningful |
| `rankHoldRequired` | — | true (flag) | C2c's "while ranking held" — corroborated via join `rankWorsened=false` |

**Evidence shape**: both detectors emit `FindingDraft` per `detectors/types.ts:36-64` — `entityKey` =
canonical page (via `canonicalUrl` with `hostContext`, G1), `metrics` (before/after/window values),
`periods`, `sources: ["ga4", "rank" | "gsc"]`, `sourceRefs.ga4Keys` (deterministic fact ids per
`deterministicGa4FactId`, `Ga4SyncRepository.ts:56+`), `thresholdsApplied` (all values above),
`correlations: []`, `evidenceType: "observational"`, `partialData` (e.g. `"rank_corroboration_absent"`),
`confidenceInputs` (coverage/volume/magnitude/persistence). `explanationFact` is fact-only prose; the
recommendation comes exclusively from a new `conversion_drop`/`engagement_drop` entry in
`OPPORTUNITY_TEMPLATES` (`opportunityTemplates.ts:56-100` shows the exact template shape incl. separate
impact factors — `businessIntent: null` can now become a real factor for the conversion detector via
`conversionSignal`, activating the documented "activate with GA4 evidence later" hook at
`opportunityTemplates.ts:20-22`).

**Skip semantics**: fetchers throw `InsufficientCoverageError` (`detectors/types.ts:88-93`) for no GA4
connection, no SUCCESS_* coverage, below `minCoverageRatio`, or below floors → detection stage records
`skipped` with reason. Failed/absent GA4 never reaches the detector (G9). Threshold version bumps 2 → 3
with the two new entries (mirrors the 1→2 bump precedent recorded in the file header).

**Alternatives considered**:
- *Per-event-name conversion detector (one finding per event)*: rejected — fan-out unbounded; goals give
  the user-chosen scope, and C2b iterates project goals (one finding per page×goal).
- *Combined "performance drop" detector*: rejected — collapses distinct signals (P26/P27: separate
  facts, separate templates, separate opportunities).

---

## R4 — Opportunities filter split (server vs client) for page/keyword/source/type/status/priority

**Decision**: **server-side** filtering for all six dimensions via an extended
`listOpportunitiesSchema` and `OpportunityService.listOpportunities` → `OpportunityRepository.listByProject`;
the client drops its local type/priority re-filtering to the search-only refinement.

**Rationale (repository evidence)**:
- The DB is already indexed for exactly this: `opportunities_project_page_idx` (projectId, page),
  `opportunities_project_keyword_idx` (projectId, keyword), `opportunities_project_type_status_idx`
  (projectId, type, status), `opportunities_project_priority_impact_idx` (projectId, priority, impactScore)
  — `src/db/opportunities.schema.ts:78-96`, with the schema comment at line 28 noting "free string,
  indexed for Task 9 filters". Filter dimensions compose as AND conditions over these indexes — no new
  indexes needed (P50).
- The server function boundary is thin today: `listOpportunitiesSchema` accepts only
  `status`/`type` (`src/types/schemas/opportunities.ts:10-16`) and the service passes them straight
  through (`OpportunityService.ts:168-180`). Extending the schema + repository filter object is the
  additive change; `requireProjectContext` keeps project scoping (P39) and the authorization tests in
  `opportunities.authorization.test.ts` extend mechanically.
- `source` filter: `sourcesJson` stores the frozen sources array (`opportunities.schema.ts:49`);
  server-side filtering on a contains-basis over the JSON column (both dialects support the existing
  pattern; if PG/D1 divergence arises, fall back to a derived `LIKE`-compatible form documented in
  tasks.md — implementation detail deferred to the task, contract fixed here: filter matches
  opportunities whose `sources` array includes the value).
- Why not extend client-side filtering (current `applyClientFilters`,
  `opportunitiesCopy.ts:176-200`): it only works over already-fetched rows; page/keyword/source
  filtering over the full project set would require fetching everything — unbounded and slow as
  opportunity volume grows across waves 1–3 (the spec's stated motivation). Client keeps only
  `search` (title/keyword/page/key text match) as a local refinement, per the existing
  `OpportunityFilterRow` shape (lines 159-172).
- Empty-state honesty is already modeled: `toOpportunitiesPageView` distinguishes `empty` (project has
  none) from `filtered-empty` (filters match none) (`opportunitiesCopy.ts:137-157`) — the new filters
  feed the existing `filteredCount` input; no new view states needed.
- Evidence detail already renders frozen evidence: `parseEvidenceJson` (`opportunitiesCopy.ts:230-273`)
  validates metrics/sources/periods/thresholdsApplied/partialData from stored JSON — C3's evidence
  detail is wired into the existing detail surface, extended only where the new detectors' fields
  (`ga4Keys`) already exist in `EvidenceView.sourceRefs` (line 210).

**Alternatives considered**:
- *Client-only filtering*: rejected (unbounded fetch; see above).
- *New filtered-list endpoint*: rejected — duplicate read path (P2); extend the existing one.
- *Server-side pagination*: out of scope for this package (P50) — the existing full-list shape is
  preserved; the schema accepts filter arrays only.

---

## R5 — conversion_drop entity grain (repository-evidence correction, P49)

**Contradiction found during T021 implementation**: the spec/contract as written scope `conversion_drop`
per (page × goal) — "entityKey = row.url" with goal-scoped per-page conversions. The live repository
cannot support this: `ga4_daily_events` stores `(projectId, propertyId, date, eventName)` with NO page
dimension (`src/db/ga4.schema.ts:187-220`; PG mirror identical), and the upsert key is
`(projectId, propertyId, date, eventName)`. There is no stored per-page goal-conversion fact to join on;
inventing one would violate P46/P47.

**Decision (smallest correction)**: `conversion_drop` emits per active **goal** (site-level), not per
page×goal. One finding per goal whose windowed conversions fall beyond the threshold. `entityKey` =
`goal:{goalId}`; evidence freezes `goalId` + goal name snapshot, both windows, the delta, and every
applied threshold. The opportunity template `pageOf` returns null for this type — the exact precedent
of the existing site-level `ga4_organic_change` template
(`opportunityTemplates.ts:89-90`: `keywordOf: () => null, pageOf: () => null`).

**What still holds unchanged**: threshold defaults (R3 table), coverage gating and skip reasons,
`minEventsPerWindow: 10` floor, idempotent emission, separate impact/confidence, frozen evidence,
goal-name snapshot surviving archive/rename. Only the entity grain changes (goal, not page×goal).

**Spec/contract updates applied with this correction**: `contracts/detector-findings.md`
(conversion_drop Entity/Scope), `spec.md` US3 scenario 1 + FR-007 wording, `tasks.md` T024 entity
wording. The Opportunities `page` filter dimension is unaffected — conversion opportunities simply
carry `page: null`, and the filter contract already specifies value-less dimensions render as
not-applicable (never fabricated). `engagement_drop` is unaffected: per-page engagement IS stored
(`ga4_daily_landing_pages` carries per-page `sessions`/`engagedSessions`), so it stays per-page via the
extended join.

---

## Cross-cutting confirmations (no new decisions — recorded to close plan.md checks)

- **Join extension point**: `joinUrlEvidence` is PURE (imports no repositories — enforced by an
  import-ban test, `AnalyticsJoinService.ts:1-10`); the organic-join deliverable extends its input types
  (adding per-page engagement/conversion fields to `JoinGa4Page`) and adds goal-scoped rows via the
  fetchers that pre-fetch — the pure function's contract is unchanged in kind. No second join system.
- **Trace**: new `ga4_goal_change` + join/detector operations emit through the existing trace taxonomy;
  secrets never logged (P41/P42); the opportunity event ledger stays authoritative/idempotent via the
  `opportunity_events_occurrence_key_uidx` (`opportunities.schema.ts:121-130`).
- **MCP**: `analytics-tools.ts` already wraps analytics reads thinly; goal-scoped variants follow the
  same wrapper pattern over the same services (P1.5, plan §4).
- **E2E**: Playwright `e2e/` exists with per-feature spec files; a goal CRUD → analytics filter →
  opportunity triage flow spec is added there (P44).