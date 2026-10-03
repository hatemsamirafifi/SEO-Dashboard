# Research — spec 011: SERP Features Normalization + Dashboard Intelligence UI

Phase 0 research for `/specs/011-serp-features-ui/`. Resolves the four open decisions from
[plan.md](./plan.md). All findings verified against the repository on 2026-10-02.

---

## R1 — Where does the SERP feature presentation derivation live?

- **Decision**: one pure derivation module at `src/server/features/serp/featurePresentation.ts`
  mapping the frozen spec-003 `SerpSnapshot.features` (`SerpFeatureSet`) into a flat, ordered
  `SerpFeatureBlock[]` display model; a thin shared client component set renders that model.
  `src/server/features/serp/types.ts` stays untouched.
- **Rationale**:
  - The normalized model is **already frozen by spec 003** in
    `src/server/features/serp/types.ts` (`SerpFeatureSet`, `.strict()`, ten families, observed-only
    keys). P14/G4 forbid a second normalization — so this package owns *one derivation over* the
    frozen model, not a new ingestion mapping.
  - "No fabrication" (FR-002) is trivially guaranteed if the derivation **iterates the keys
    actually present** on the object instead of iterating a fixed family list and probing —
    absent families are `undefined` and never enter the output.
  - Server-side placement makes the derivation importable by UI, MCP tools, and future
    detectors/reports without duplication; the client keeps only rendering. Import-ban boundary
    tests (`serpBoundaries.test.ts`) are extended to pin that UI never imports provider JSON.
- **Alternatives considered**:
  - Normalize feature display inside each existing UI surface (`SerpAnalysisCard.tsx`,
    `RankTrackingTableParts.tsx`) — rejected: two divergent renderings of the same frozen
    contract, exactly the drift A2/P14 prohibit. (Notably, `RankTrackingTableParts.tsx` *today*
    uses a different feature vocabulary — `featured_snippet`, `knowledge_panel`, `top_stories`,
    `ai_overview` — than the frozen contract's `featured_result`/`knowledge_graph`/`news`; this
    package consolidates that split vocabulary onto the frozen keys.)
  - Extend the frozen `SerpFeatureSet` with display-ready fields — rejected: the 003 contract is
    a hard gate (G4); additive display metadata belongs in a view model, not the stored snapshot.

## R2 — How do the existing per-section state derivations unify into the deterministic A2 mapping?

- **Decision**: keep the existing 11-state enumeration **`DASHBOARD_SECTION_STATES`**
  (`loading | ready | empty | not_connected | no_data | partial | stale | api_failed |
  permission_failed | sync_running | sync_failed`) and the existing `mapStoredSectionState` in
  `src/shared/intelligence.ts` as the single mapping home; **extend its input contract** to
  `MapStoredSectionStateInput` gaining `stale?: boolean`, `permissionDenied?: boolean`, and
  `loading?: boolean`, make precedence an exported, documented decision table
  (`SECTION_STATE_DECISION_MATRIX`), and route **every** section's state derivation in
  `DashboardService` through it. Sections keep computing their metrics exactly as today; only the
  state derivation converges.
- **Rationale**:
  - P30's minimum list and the existing enum already agree 1:1 — the "unified model" exists, so
    A2 is a consolidation + determinism + test-surface job, not a redesign. Rewriting the enum
    would churn every section test for zero truthfulness gain (P50).
  - Verified gap in `DashboardService.ts` (lines 613–1076): sections hand-derive states outside
    the mapper — e.g. `state: previousCovered ? "ready" : "partial"` (×2), `state: "ready"`,
    `state: items.length === 0 ? "empty" : "ready"`, `state: snapshot.stale ? "stale" : "ready"`.
    Converging these through one input-shaped mapper is the actual A2 deliverable and is fully
    testable via a generated state matrix.
  - Precedence order (documented, deterministic): `loading` → `not_connected` →
    `permission_failed` → `sync_running` → `sync_failed` → `api_failed` (exception path via
    `safeSection`) → `no_data` (both windows empty) → `empty` (connected, read OK, zero items for
    list sections) → `stale` → `partial` (previous-window coverage missing) → `ready`. Failure
    states always beat data-availability states, which always beat `ready` — so failure can never
    surface as zero.
- **Alternatives considered**:
  - Per-section discriminated-union state machines — rejected: eleven states × eight sections of
    bespoke transitions is the drift this package exists to remove (P30, P2).
  - Move state derivation fully client-side — rejected: state must be deterministic from the
    service result (spec FR-012); splitting it creates two sources of truth (P42-adjacent).

## R3 — PAA placement rendering rule (S9) on the SERP surface

- **Decision**: PAA renders as a **feature block adjacent to the results list** (desktop) and as
  its **own card in card order** (mobile), positioned by the stored `placement` when present;
  when `placement` is absent it renders after the top organic block without occupying a numbered
  position. PAA **never** inserts into, displaces, or renumbers `organicResults` positions.
- **Rationale**:
  - Spec-003 contract already says PAA items carry *optional* `placement` metadata and that
    rendering policy belongs to this package; the snapshot's `organicResults` ordering is
    "position-ordered for display; never a merge identity." Keeping PAA out of the positional
    list preserves rank truthfulness (P46) and 007's enrichment position mapping.
  - Absent-placement fallback is needed because `placement` is `nullish` in the contract;
    defaulting to "after the top positions" preserves visibility without inventing a position.
- **Alternatives considered**:
  - Render PAA inline at its numeric placement among organic rows — rejected: it would visually
    sit "between position N and N+1" and read as a displaced rank; S9 and the acceptance criteria
    explicitly preserve organic numbering.
  - Always render PAA at a fixed position regardless of `placement` — rejected: discards observed
    data (P47 provenance).

## R4 — Mobile card view relationship to the existing dense view + breakpoint

- **Decision**: one new responsive component family in `src/client/features/serp/`
  (`SerpResultCards`) used **in place of** the dense table below the established mobile breakpoint
 , with both views consuming the same derived `SerpFeatureBlock[]` + result rows. Breakpoint:
  Tailwind `md` (768px); card view below, dense table at/above. Metrics live in a per-card
  disclosure (`<details>`/expansion), matching the repository's existing pattern.
- **Rationale**:
  - One data model feeding two layouts keeps P2/P14 (no competing read paths); the breakpoint is
    the project's existing responsive convention (Tailwind default scale, already used across
    `client/features`).
  - Feature blocks join the card rhythm as leading/interleaved cards so SC-003's zero-overflow
    check covers them directly; long PAA lists cap height + scroll internally rather than
    stretching the page.
- **Alternatives considered**:
  - CSS-only reflow of the existing table — rejected: dense tables don't reflow into a
    position/result/summary card honestly; spec explicitly asks for a card layout change.
  - A separate mobile page/route — rejected: duplicate reads and state handling; one route with a
    responsive component keeps the state surface unified.

---

## Consolidated resolution table

| Unknown | Resolution | Contract/test anchor |
| --- | --- | --- |
| R1 feature derivation home | `server/features/serp/featurePresentation.ts` pure fn → shared client blocks | contracts/serp-feature-presentation.md; `featurePresentation.test.ts` |
| R2 unified 11-state mapping | Extend `mapStoredSectionState` input + exported decision matrix; all `DashboardService` sections route through it | contracts/dashboard-sections.md; state-matrix tests |
| R3 PAA placement | Feature block beside list / own card; placement-honored; never displaces organic positions | contracts/serp-feature-presentation.md § placement |
| R4 mobile card view | Responsive `SerpResultCards` below `md`; same data as dense view; metrics in expansion | contracts/serp-mobile-card-view.md; `serp-features-mobile.spec.ts` |

All NEEDS-CLARIFICATION-class unknowns from plan.md Technical Context are resolved; none remain.
