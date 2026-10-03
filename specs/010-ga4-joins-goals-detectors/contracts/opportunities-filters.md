# Contract: Opportunities List Filters & Evidence Detail

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Extends**: `listOpportunities` server fn → `OpportunityService.listOpportunities` →
`OpportunityRepository.listByProject` (existing chain — no duplicate read path, P2/P50). Research
decision R4 (server-side filters; client keeps search-only refinement) is binding here.

## Filter schema (Zod, `.strict()` — trust boundary at the server fn)

```ts
listOpportunitiesSchema = {
  projectId: string,
  // single-value (existing, unchanged):
  status?: "open" | "in_progress" | "completed" | "dismissed",
  type?: string,
  // single-value new:
  page?: string,           // equality on opportunities.page
  keyword?: string,        // equality on opportunities.keyword
  source?: string,        // sourcesJson contains value
  // multi-value new (OR within dimension, AND across dimensions):
  statuses?: OpportunityStatus[],
  types?: string[],
  priorities?: ("critical" | "high" | "medium" | "low")[],
}
```

Empty array = "all" for that dimension (existing convention: absent and empty mean the same). All
dimensions AND-compose. `source` matches opportunities whose stored `sources` array contains the value
(string containment over `sourcesJson`, both dialects; exact contract: value must equal one array
element, never substring).

## Repository composition

AND over existing indexes — `opportunities_project_status_idx`,
`opportunities_project_type_status_idx`, `opportunities_project_page_idx`,
`opportunities_project_keyword_idx`, `opportunities_project_priority_impact_idx`
(`src/db/opportunities.schema.ts:78-96`). No new indexes, no new columns, no new tables (P50).
Project scope is always the first predicate (P39).

## View semantics (honest states — P30/G9)

| State | Rendered as | Source |
| --- | --- | --- |
| project has zero opportunities | `empty` (scheduling explainer) | `toOpportunitiesPageView` (existing) |
| filters match nothing | `filtered-empty` (explicit, distinct from `empty`) | existing `filteredCount` input |
| fetch fails | `error` line — never an empty list | existing `isError` |
| filter dimension has no available values in the project | that facet is disabled/not-applicable — never a fake empty choice | facet availability derived server-side from the result set |
| GA4-backed types when GA4 disconnected | simply absent from results (no fabricated zero-severity rows) | natural consequence of stored data |

Sorting: unchanged (existing `compareOpportunities` — impact/confidence/priority order).

## Evidence detail (existing surface, P27/P31)

`getOpportunity` (existing) already returns the row + lifecycle events. Detail rendering extends the
existing `EvidenceView` parse (`opportunitiesCopy.ts`):

- frozen `metrics` render as recorded — never recomputed;
- `sourceRefs.ga4Keys` (new detectors) joins the existing gscFactIds/rankSnapshotIds/auditIssueIds
  rendering path — the field already exists in `EvidenceView.sourceRefs`;
- `partialData` entries render as explicit per-source unavailability notes (never hidden);
- corrupt/absent evidence JSON surfaces as the explicit corrupt-evidence note (existing
  `parseEvidenceJson` → null behavior) — never fabricated rows;
- thresholdsApplied render as "thresholds applied at detection" (reproducibility, not live config).

## Client refinement split

- Server filters: page/keyword/source/type(s)/status(es)/priorities — all six C3 dimensions.
- Client keeps ONLY `search` (free-text over title/keyword/page/logicalKey — existing
  `applyClientFilters` shape, minus type/priority arrays which move server-side).
- `filteredCount` continues to feed `toOpportunitiesPageView` unchanged.

## Invariants (tested)

1. Any two filter dimensions compose correctly (matrix fixture: type × status, page × type,
   keyword × priority, source × status).
2. Unknown/invalid enum values fail validation at the boundary (strict schema).
3. Cross-project ids never resolve (project context middleware, authorization tests extended).
4. Filtering never mutates stored rows or scores; a filtered-empty never writes analytics/audit
   artifacts (read-only path).
5. No filter combination triggers scans, provider calls, or recomputation (read-only, G10).