# Contract: SERP Feature Presentation (PR7 / S4–S5, S9)

Audience: every surface that renders a stored SERP snapshot (keywords SERP analysis, rank-tracking
keyword detail, MCP read tools that summarize SERPs, future reports/detectors).

## Rule 0 — Source of truth

The only SERP feature model is the frozen spec-003 contract
(`src/server/features/serp/types.ts` → `SerpFeatureSet`, `serpSnapshotSchema`, `.strict()`).
This package **derives a display model** from it; it never re-normalizes provider payloads and
never extends the stored schema.

## Derivation contract

```ts
// src/server/features/serp/featurePresentation.ts
toSerpFeatureBlocks(features: SerpFeatureSet): SerpFeatureBlock[]
```

**Guarantees:**

1. **Observed-only.** For ten frozen families, one output block exists **iff** the family key is
   present on the input. Absent families produce nothing — this is the mechanism-level proof of
   spec FR-002 (no fabrication) and P8/P9 (absence is not a zero).
2. **Order.** Blocks arrive in deterministic render order:
   `featuredResult` → `localPack` → `peopleAlsoAsk` → `images` → `videos` → `shopping` →
   `news` → `knowledgeGraph` → `sitelinks` → `relatedSearches`. `order` is exposed per block;
   PAA's stored `placement` (when present) refines — never renumbers — positioning per Rule 3.
3. **Pass-through fidelity.** `items` equal the snapshot's stored items (minus exact-duplicate
   sweeps, each logged). Optional item fields stay optional; UI renders them when present and
   shows nothing (not "—", not `0`) when absent.
4. **No unknown families.** Impossible past `.strict()` ingestion; the derivation additionally
   ignores and logs any non-frozen key so a schema-drift bug degrades safely instead of crashing
   a SERP view (spec FR-005).

## Family vocabulary consolidation (S4)

Frozen family → label → legacy chip key(s) retired (`RankTrackingTableParts.tsx`):

| Frozen family | Label | Retired legacy keys |
| --- | --- | --- |
| `featuredResult` | Featured snippet | `featured_snippet` |
| `peopleAlsoAsk` | People Also Ask | `people_also_ask` |
| `relatedSearches` | Related searches | — (new) |
| `localPack` | Local pack | `local_pack` |
| `images` | Images | `images` |
| `videos` | Videos | `video` |
| `shopping` | Shopping | `shopping` |
| `news` | News | `top_stories` |
| `knowledgeGraph` | Knowledge panel | `knowledge_panel` |
| `sitelinks` | Sitelinks | — (new) |

`ai_overview` is **not** in the frozen ten-family contract — it is not rendered by this package
(and any AI-overview work belongs to a future spec that extends the 003 contract properly).

## Placement rule for People Also Ask (S9)

- PAA is a **feature block**, never a member of the numbered organic list. Rendering must never
  renumber, shift, or interleave organic `position`s because of PAA.
- When a PAA item-level or block-level `placement` is present, the PAA block renders adjacent to
  that region of the list ("appears alongside results around position N", observational wording).
- When `placement` is absent, PAA renders immediately after the first organic block (after the
  featured result if present, else after the top results), clearly labeled, without occupying a
  position number.
- Rank-tracking chips and keyword-level summary badges (count of PAA items present) read from
  blocks, not from a parallel string list.

## Degradation interplay (spec-007)

Feature rendering never consults enrichment status; enrichment fields degrade independently per
row (`available/partial/unavailable/failed`). A SERP whose enrichment failed renders its full
organic list + full feature blocks with enrichment columns/fields marked unavailable — FR-006.

## Consumer obligations

- UI consumers import `toSerpFeatureBlocks` (server derivation is re-exported through the shared
  boundary) and the shared block components; they must not contain per-family rendering logic.
- `serpBoundaries.test.ts` extended: forbid importing provider JSON shapes or re-declaring family
  keys outside the frozen contract + this module.
