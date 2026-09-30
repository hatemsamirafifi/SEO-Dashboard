# Contract: Lost-Backlink Opportunity

**Feature**: `008-lost-backlink-opportunity` | **Date**: 2026-09-30

Detector + opportunity contract consumed by the intelligence scan pipeline. Inputs are existing stored snapshots; the existing `backlink_change` signal is unchanged. See [research](research.md), [data model](data-model.md).

## `lost_backlinks` detector

- **Input**: two newest stored `backlink_snapshots` rows for the project (newest-first by id) inside the freshness window (default 30 days); fewer than 2 rows or a stale newest row ⇒ skip with recorded reason.
- **Floor**: emit only when `lostReferringDomains ≥ 3` (default; configurable, versioned threshold). Below floor, unknown totals, or failed/partial comparison ⇒ no emission.
- **Name resolution**: only after the floor triggers, resolve bounded top-N lost-domain names via the cached referring-domains service path (lost-filtered, single bounded page); resolution failure ⇒ no-trigger (never a loss).
- **Output**: one `FindingDraft` per qualifying pair — entityKey `backlinks:${domain}`, fact-only prose, frozen evidence (named domains, counts, snapshot timestamps, thresholds applied, `two_point_heuristic` partial-data label), confidence capped per the heuristic convention.
- **Invariants**:
  - Provider failure, partial data, or insufficient coverage never produces a loss finding (G9).
  - Domain comparison uses shared domain-identity normalization (alias/case folds never count as loss).
  - Re-running over identical inputs emits nothing new (stable finding keys; ledger idempotency).

## Opportunity materialization

- New `OPPORTUNITY_TEMPLATES.lost_backlinks` entry: `type: "backlinks"` (existing list filters and lifecycle apply unchanged), reclaim-oriented recommendation (facts vs recommendations split), impact/confidence scored separately via the existing model.
- `logicalKey = lost_backlinks:backlinks:${domain}` — distinct from `backlink_change:…`; INSERT-ON-CONFLICT + event-key hashing make re-scans idempotent.
- Full lifecycle (open/in-progress/completed/dismissed with reason) with every transition recorded once in the event ledger.

## Coexistence

- The `backlink_change` detector, template, and fixtures are byte-identical after this feature. Both findings may emit from the same snapshot pair (aggregate net-movement + named loss) under distinct logical keys — additive signal, never double materialization of one key.

## Threshold contract

- `lost_backlinks: { minSnapshots: 2, freshnessDays: 30, minReferringDomains: 3 }` in the shared versioned threshold table; `THRESHOLD_VERSION` unchanged (no existing band moves). Thresholds echo in every finding's evidence.

## Stability promise

Detector key, floor semantics, evidence shape, and the no-trigger rules are frozen for consumers (opportunities UI, reports, SAM); additive evidence fields only, no renames without versioning.
