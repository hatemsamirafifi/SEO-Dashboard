# Frozen Contract: Normalized SERP Snapshot

**Feature**: `003-serp-contract-discovery` | **Frozen**: 2026-09-28 | **Gate**: G4

This is THE single normalized SERP contract. All downstream consumers (007 enrichment, 011 features
UI, detectors, future storage) import the Zod schemas and types from
`src/server/features/serp/types.ts` — never raw provider JSON, never a second resolver, never
provider-specific UI models (FR-004). Types in code are authoritative for shape; this document is the
reviewable record.

## Logical identity (FR-002)

```
identity = (
  canonical keyword,          // trimmed
  engine,                     // normalized id, lowercase ("google")
  canonical location,         // locationCode (int) + countryCode (upper) + locationName
  canonical language,         // lowercase BCP-47 core ("en")
  normalized device enum,     // desktop | mobile
  checkedAt full ISO          // observation timestamp; date-only rejected
)
```

- All dimensions canonicalized **before** key construction
  (`canonicalSerpSnapshot` → `serpSnapshotIdentityKey` in `src/server/features/serp/types.ts`).
- `checkedAt` is a full ISO timestamp — multiple same-day checks never collide.
- `provider` + `providerStatus` are **provenance**, excluded from identity.
- `contentHash` is an **optional integrity/dedup/validation aid**, never identity.
- `projectId` is **tenancy/storage-key scoping** only, excluded from observation semantics.
- Display order of `organicResults` is never used as identity.

## SerpSnapshot (Zod: `serpSnapshotSchema`)

| Field | Type | Rules |
|---|---|---|
| keyword | string (min 1) | Canonical keyword form (trimmed by identity canonicalization) |
| engine | enum `google` | Normalized engine id |
| location | object | `{ locationCode: int>0, locationName, countryCode }` |
| language | string (min 1) | Canonical language code |
| device | enum `desktop \| mobile` | Normalized device |
| checkedAt | full ISO string | OpenSEO fetch/observation time — date-only rejected |
| providerSnapshotAt | full ISO string | Provider-snapshot time; distinct from fetch time (FR-006); freshness policy consults this, not fetch time alone (P19) |
| organicResults | SerpOrganicResult[] | Position-ordered for display; never merge identity |
| features | SerpFeatureSet | Only OBSERVED families present; absent = absent (FR-007) |
| provider | enum `dataforseo \| serper \| zenserp` | Provenance only |
| providerStatus | string | Provider call status class |
| contentHash | string \| null (optional) | Integrity/dedup aid only |

Strict object: unknown keys rejected. Extra provider fields are ignored by the normalized model
(available via trace/debug, not via the contract).

## SerpOrganicResult

| Field | Type | Rules |
|---|---|---|
| position | int ≥ 1 | As observed |
| title | string \| null | Raw observed value (enrichment canonicalizes downstream) |
| url | string | Raw observed URL |
| domain | string | Raw observed domain |
| resultType | string \| null | e.g. `organic`, `sitelinks-augmented` (raw provider classification) |
| featureRefs | string[] | Associated feature keys (see enum below), default [] |

## SerpFeatureSet

Optional members — each present **only when observed** (absent family ≠ empty claim; never fabricated,
never null-coerced):

| Family key | Payload |
|---|---|
| `featuredResult` | `{ title, url?, domain?, snippet }` |
| `peopleAlsoAsk` | `{ items: [{ question, url?, placement? }] }` — placement is optional observed metadata; rendering policy is the 011 package's decision |
| `relatedSearches` | `{ items: string[] }` |
| `localPack` | `{ items: [{ title, url?, domain?, address?, rating?, reviewCount? }] }` |
| `images` | `{ items: [{ url, title?, domain? }] }` |
| `videos` | `{ items: [{ url, title?, domain? }] }` |
| `shopping` | `{ items: [{ title, url?, domain?, price? }] }` — price only when provider observed it |
| `news` | `{ items: [{ title, url?, domain?, sourceName?, publishedAt? }] }` — publishedAt full ISO or absent |
| `knowledgeGraph` | `{ title, url?, domain?, description? }` |
| `sitelinks` | `{ items: [{ url, domain?, title? }] }` |

Feature keys (for `featureRefs` and detector vocabulary): `featured_result`, `people_also_ask`,
`related_searches`, `local_pack`, `images`, `videos`, `shopping`, `news`, `knowledge_graph`,
`sitelinks` (`SERP_FEATURE_KEYS`, `src/server/features/serp/types.ts`).

**Provider-gap truth (recorded by the discovery report, research.md §C):** no provider payload parsing
for these families exists yet anywhere in the repo — the only current feature signal is type strings
(`src/server/lib/dataforseo/serp.ts:139`). This contract is the design target; 007 defines which
families the providers it calls can actually populate, and 011 renders only observed families.

## Metric vocabulary (FR-005, P16)

Provider-accurate names ONLY:
- **DataForSEO**: Domain Rank, Page Rank, referring domains, backlinks, rank info (`rank_group` /
  `rank_absolute`), etv (estimated traffic value) — estimated traffic only where genuinely available.
- **Serper.dev / Zenserp**: their documented credit/position fields as observed.
- Provider-supported spam/risk scores only when the provider actually supplies them.

<!-- PROHIBITED-METRIC-BAN (guard-exempt line): proprietary third-party metric labels — DA, PA, DR, TF, CF — and "Domain Authority"/"Page Authority"/"Domain Rating" synonyms are banned from these surfaces; static guard: src/server/features/serp/serpBoundaries.test.ts -->

**Metric naming rule**: any metric label beyond the provider-accurate set above is prohibited; see the
ban note above. Static guard: `src/server/features/serp/serpBoundaries.test.ts`.

## Absence semantics (FR-007, P8)

- An unobserved family: the key is absent from `features` (undefined after parse).
- A null-coerced `features: { featuredResult: null }` **fails validation** (strict object, non-null
  schemas).
- Empty `items` may only appear when the provider observed an EMPTY block, never as a stand-in for
  "we did not look".
- Failed provider calls never produce a snapshot at all — they produce errors/call diagnostics
  (failure ≠ fact).

## Consumer obligations (P14, FR-004, G4)

1. **007 (enrichment)**: snapshot storage keyed by the logical identity above; merge identity from
   `serpSnapshotIdentityKey`; target-metric caching keyed off normalized URL/domain separately.
2. **011 (features UI)**: renders `SerpFeatureSet` families from observed snapshots only; decides
   PAA placement/sitelinks rendering policy; distinguishes truncated/complete snapshots via provider
   responses, never fabricates families.
3. **Detectors/UI generally**: import `serpSnapshotSchema`/types only; the boundary test
   (`serpBoundaries.test.ts`) asserts zero raw-provider tokens
   (`SerpLiveItem`, `DataforseoApiResponse`) outside the resolver seams.
4. **Pipelines**: both existing SERP pipelines (rank-check resolver; DataRouter `dataType:"serp"`)
   produce this shape when they surface snapshots; no third resolver (P2).

## G4 sign-off (SC-002)

- **Contract**: this document + `src/server/features/serp/types.ts` (frozen Zod schemas).
- **Fixtures**: full (all 10 families) + sparse (5 of 10) validated —
  `src/server/features/serp/serpSnapshot.test.ts` (10 tests).
- **Boundary guards**: `src/server/features/serp/serpBoundaries.test.ts` (no-raw-parsing, report
  integrity, vocabulary) — 3 tests.
- **Discovery**: `specs/003-serp-contract-discovery/research.md` (report, §D discrepancies,
  walkthrough log).
- **Status: SATISFIED (frozen 2026-09-28).** Packages 007 (enrichment) and 011 (features UI) MUST
  consume this contract as their mandatory input; recorded as satisfied in
  `docs/speckit-implementation-plan.md`.