# Contract: SERP Mobile Card View (PR7 / S9 UI)

## Scope

Responsive rendering of stored SERP results and feature blocks. Below the `md` breakpoint
(768px) the SERP surface renders the card view in place of the dense table; at/above `md` the
existing dense view is unchanged. One route, one data path, two layouts.

## Card anatomy (per organic result)

| Element | Always visible | Source |
| --- | --- | --- |
| Position | yes | stored `organicResults[].position` (never recomputed) |
| Result identity | yes | title → URL/domain fallback chain |
| One-line summary | yes | stored snippet/description when present; absent stays absent |
| Feature chips | when present | shared family chips from the presentation derivation |
| Metrics (rank/enrichment) | expansion only | stored/007 values with their availability status |

- Metrics expansion: per-card disclosure; closed by default; expanding never shifts sibling cards
  (no layout reflow).
- Truncation: titles two lines max with ellipsis; URLs single-line ellipsis; no horizontal scroll
  inside any card region.

## Feature blocks in card rhythm

- Each `SerpFeatureBlock` renders as its own card in the block order defined by
  [serp-feature-presentation.md](./serp-feature-presentation.md), interleaved with result cards
  at its placement slot (PAA: placement-honored or post-top-results fallback).
- Long PAA lists: capped height with internal scroll; the card itself never grows the page
  beyond the viewport.
- Local pack: items render as compact rows (title, address when present, rating when present) —
  never a fabricated map.

## States (SERP view, aligned with dashboard vocabulary)

`loading` (skeleton cards) / `ready` / `empty` (keyword tracked, no stored SERP yet) /
`error` (stored read failed — retry affordance, never an empty list masquerading as data) /
`degraded` annotation on enrichment fields only. A failed enrichment never blocks result or
feature cards (FR-006).

## Acceptance hooks (test IDs)

`data-testid="serp-result-card"`, `"serp-feature-block-{family}"`, `"serp-card-expand"`;
overflow assertion target `data-testid="serp-results-mobile"`.
