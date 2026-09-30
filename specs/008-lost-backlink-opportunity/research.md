# Research: Lost-Backlink Opportunity

**Feature**: `008-lost-backlink-opportunity` | **Date**: 2026-09-30

All unknowns resolved via spec clarification (2026-09-30) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Two-stage input — floor on stored aggregates, names resolved only on trigger

- **Decision**: The new detector's input fetcher (mirroring `fetchBacklinkChangeInput`, `backlinkChange.ts:76-114`) first runs the cheap stored-aggregate check over the two newest `backlinkSnapshots` rows (`BacklinkSnapshotRepository.getRecentForProject`, newest-first by autoincrement id: `:64-74`): fewer than 2 snapshots or a stale newest snapshot ⇒ `InsufficientCoverageError` (no-trigger, recorded reason). Only when `lostReferringDomains ≥ 3` on stored data does it resolve lost-domain names via a single bounded backlinks-ROWS call (`is_lost = true` filter, limit 100, no pagination walk), distinct-normalized `domain_from` values frozen into evidence (bounded top-10 + aggregate count). The referring-domains endpoint cannot serve this leg (its item schema carries no `is_lost`/`lost_date` fields — verified in `backlinks-schemas.ts:60-71`). Any provider failure at the name-resolution stage ⇒ `InsufficientCoverageError` (no-trigger) — never a loss, preserving G9.
- **Rationale**: Stored snapshots carry aggregates only (`backlink_snapshots` columns: totals + `lostReferringDomains`, `app.schema.ts:447-459`); the internal provider serves summary from snapshots and explicitly declines per-domain calls (`internal-provider.ts:203-211` — "history/rows/referring_domains/domain_pages must fall through to DataForSEO"). Names must therefore come from the cached provider path — but only after the free floor check triggers, so scans cost nothing in the common case. Scan-time billing uses a system billing customer scoped to the project's organization, mirroring the scheduled-rank-checks precedent (`scheduledRankChecks.ts:66-71`); the metered client's budget asserts remain the guard (no new paid-plan gate — a blocked call surfaces as no-trigger, never as loss). Failure anywhere ⇒ no-trigger (matches existing `fetchBacklinkChangeInput` gating at `:86-102`).
- **Alternatives considered**: Extending `backlink_snapshots` with a bounded lost-domain JSON column (additive D1+PG + migration + parity + writer change in `DashboardService.ensureBacklinkSnapshot`) — rejected for 008: snapshot refresh is dashboard visit-triggered (not scan-aligned, so names would be stale/missing at scan time anyway), it doubles the paid surface of every refresh, and the spec mandates a detector over existing inputs, not a storage change. Revisitable if scan-time resolution proves too costly.

## Decision 2: Cost bound for the name-resolution leg

- **Decision**: The paid leg fires at most once per scan per project, only when the aggregate floor already triggered, as a single lost-filtered bounded backlinks-rows page (`is_lost = true`, limit 100, no pagination walk — G8), through the router's cache-first + singleFlight + budget-assert pipeline (`data-router.ts:109-159`, metered client) with system billing scoped to the project's organization. Cache hits make repeat scans free.
- **Rationale**: Cache-first + budget guards are the house cost mechanism (P11-P13); the floor gate means the paid leg fires only on genuine loss events.
- **Alternatives considered**: Always-on name resolution per scan (rejected: paid calls on every scan regardless of loss); unbounded domain listing (rejected: evidence is bounded top-N + aggregate count per spec).

## Decision 3: Threshold entry, no version bump

- **Decision**: New `lost_backlinks` entry in `DEFAULT_DETECTOR_THRESHOLDS` (`intelligence-thresholds.ts:24`): `{ minSnapshots: 2, freshnessDays: 30, minReferringDomains: 3 }` — echoing `backlink_change`'s gates plus the binding floor. `THRESHOLD_VERSION` stays 2: no existing detector's bands change, so no band migration is required (the version comment at `:8-11` bumps only on semantic changes to existing detectors).
- **Rationale**: Follows the injected-thresholds convention exactly (`thresholdNumber` fails loudly on missing keys, `detectors/types.ts:71-80`); a version bump with no semantic change would invalidate existing threshold pins for nothing.
- **Alternatives considered**: Bumping `THRESHOLD_VERSION` to 3 (rejected: nothing existing changes; the new key is additive).

## Decision 4: Detector registration and template

- **Decision**: New `lostBacklinks.ts` detector (`detectorKey: "lost_backlinks"`, version 1, `requiredSources: ["backlinks"]`, same snapshot coverage requirement as `backlink_change`, `minConfidenceToEmit: 40`, confidence 50 with `two_point_heuristic` partial-data label — inheriting `backlinkChange.ts:178-192` values). Register in `registry.ts` DETECTORS; add the file to the boundaries `DETECTOR_FILES` list. New `OPPORTUNITY_TEMPLATES.lost_backlinks` entry (`opportunityTemplates.ts`, next to `backlink_change:283`) with `type: "lost_backlinks"` — a distinct type string is REQUIRED by the existing template-distinctness invariant (`opportunityTemplates.test.ts`: template keys map 1:1 to distinct types). Existing list filters and triage keep working through two one-line additions: `"lost_backlinks"` in `OPPORTUNITY_TYPES` plus its `TYPE_META` label (the only UI-surface change; server-side type filtering is a free string match). Reclaim-oriented recommendation; `factorsOf` reusing the decline/trafficPotential pattern keyed on lost referring domains. `logicalKeyOf` (`materializeFinding.ts:29-31`) yields `lost_backlinks:backlinks:${domain}` — distinct from `backlink_change:backlinks:${domain}`, so no collision and no double materialization of the same key (INSERT ON CONFLICT + eventKey hash, `:66-86`).
- **Rationale**: Mirrors the `striking_distance` precedent exactly (own detector file + registry entry + template with its own type string, `materializeFinding.test.ts:285-329` lifecycle tests). Unlike wave-1's `striking_distance` (unfilterable raw-type label), the new type is registered in the UI vocabulary so the spec's filterability requirement (FR-007) holds.
- **Alternatives considered**: Shared `"backlinks"` type (rejected during implementation: violates the existing template-distinctness invariant — the test enforces one type per template key); folding losses into the existing `backlink_change` template (rejected: spec FR-008's split — the named-domain evidence and prioritization need their own emission path).

## Decision 5: No new insight group by default

- **Decision**: `striking_distance` (spec 004) shipped with no `insightGroups.ts` entry (verified: only `backlink_change:109` exists there) — insight-group mapping is optional per detector. `lost_backlinks` ships without a new group; the task verifies the backlinks narrative still reads coherently, adding a mapping only if composer output degrades.
- **Rationale**: Avoids scope creep into the insight composer; the opportunity template + existing backlinks group carry the narrative.
- **Alternatives considered**: New `lost_backlinks` insight group (rejected unless composer output proves to need it — verify, don't assume).

## Decision 6: `backlink_change` untouched, coexistence defined

- **Decision**: The existing detector, its template, and its fixtures are not modified. Both detectors may emit from the same snapshot pair (aggregate net-movement + named loss); distinct detectorKeys give distinct logical keys and ledger events — this is additive signal, not duplication (spec FR-008).
- **Rationale**: Verified non-collision via `logicalKeyOf`; FR-008 explicitly requires the aggregate signal unchanged.
- **Alternatives considered**: Suppressing the general finding when the loss opportunity fires (rejected: net-movement context including gains would be lost; the two findings answer different questions).

## Decision 7: Fixture and negative-test landing spots

- **Decision**: New `lostBacklinks.test.ts` with the floor matrix (0/1/2/3/5+), failure negatives (failed sync, single snapshot, stale pair, name-resolution failure), and idempotency (same inputs twice → one opportunity, one ledger event), seeded via the `detectorTestSeeds.ts:334` backlink pattern; input-fetcher negatives extend `detectorInputs.test.ts` (backlink pattern at `:213`); template scoring cases extend `opportunityTemplates.test.ts` (backlink pattern at `:391`).
- **Rationale**: Mirrors existing detector test anatomy 1:1; no new harness needed.
- **Alternatives considered**: Reusing `backlinkChange.test.ts` for the new detector (rejected: separate detectorKey, separate file — house convention is one suite per detector).
