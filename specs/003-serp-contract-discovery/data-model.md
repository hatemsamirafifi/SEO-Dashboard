# Data Model: SERP Contract Discovery and Freeze

**Feature**: `003-serp-contract-discovery` | **Date**: 2026-09-28

No new persisted tables. Models below are the frozen normalized contract (types + validation).

## SerpSnapshot

One normalized keyword SERP observation.

| Field | Type | Rules |
|---|---|---|
| keyword | string | Canonical keyword form |
| engine | enum | Normalized engine id (e.g. google) |
| location | object | Canonical locationCode/location identity |
| language | string | Canonical language code |
| device | enum | Normalized device (desktop/mobile/…) |
| checkedAt | ISO string | Full observation timestamp; never date-only |
| organicResults | SerpOrganicResult[] | Position-ordered for display; never used as merge identity |
| features | SerpFeatureSet | Only observed families present |
| provider | string | Provenance only (dataforseo/serper/zenserp) |
| providerStatus | string | Provider call status class |

**Logical identity**: `(keyword, engine, location, language, device, checkedAt)` — all dimensions
canonicalized pre-key. Provider excluded. ProjectId excluded (tenancy, storage key only).
**Optional**: `contentHash` for integrity/dedup/validation — never identity.

## SerpOrganicResult

| Field | Type | Rules |
|---|---|---|
| position | integer | As observed |
| title / url / domain | string | Raw observed values (enrichment canonicalizes downstream) |
| resultType | string \| null | e.g. organic, sitelinks-augmented |
| featureRefs | string[] | Associated feature keys (e.g. featured, local_pack) |

## SerpFeatureSet

Optional members, present only when observed: `featuredResult`, `peopleAlsoAsk[]` (+ optional placement
metadata), `relatedSearches[]`, `localPack[]`, `images[]`, `videos[]`, `shopping[]`, `news[]`,
`knowledgeGraph`, `sitelinks[]`.

**Validation**: Absent family ≠ empty claim; sparse fixtures (half families missing) must validate.
Metric vocabulary restricted to provider-accurate names (see contracts/serp-snapshot.md).

## Relationships

`SerpSnapshot 1—* SerpOrganicResult`; `SerpSnapshot 1—1 SerpFeatureSet`. Downstream (007) enrichment rows
reference snapshots by logical identity; target-metric cache keys off normalized URL/domain (separate).
