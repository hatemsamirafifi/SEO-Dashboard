# Data Model: Canonical SEO URL Identity

**Feature**: `006-canonical-url-identity` | **Date**: 2026-09-30

No new persisted tables. Models below are computed value contracts; sources are existing rows.

## CanonicalPageIdentity

The deterministic full URL identity shared by all cross-source page joins and entity keys. Computed by
the single identity helper; never stored as a primary value (stored rows keep source form).

| Field         | Type           | Rules                                                                                                                                                                |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sourceUrl     | string         | Original, unmodified source value (path-only or full URL)                                                                                                            |
| canonicalForm | string         | Full identity: folded scheme + folded host (+ non-default port) + normalized path; or path-scoped form when no host context; or `(not set)` sentinel for blank input |
| hostContext   | string \| null | Project host used to resolve path-only rows; null = path-scoped, never invented                                                                                      |
| policy        | enum           | The single documented identity policy version that produced the form                                                                                                 |

**Validation**: `canonicalForm` is deterministic — same `(sourceUrl, hostContext)` always yields the same
form; two different domains never yield the same form (cross-domain isolation; tested).

## ProjectHostContext

| Field | Type   | Rules                                                                                                                             |
| ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| host  | string | Lowercased bare host parsed from `projects.domain` (scheme/`sc-domain:` prefixes stripped); absent when the project has no domain |

## IdentityFoldRules

The single policy (versioned in `contracts/canonical-identity.md`): fold www→bare and http→https only;
all other subdomains distinct; non-default ports preserved; non-root trailing slash folds away, root
stays root; duplicate slashes collapse; fragments and query strings excluded per the shared policy;
percent-encoding normalized safely (uppercase hex, unreserved decoded, non-ASCII preserved); hosts
case-insensitive; paths case-preserved.

## Provenance

Every joined row and entity key carries the original `sourceUrl` alongside the identity (`SourceUrlProvenance`
in spec) so debugging and display never depend on the folded form.

## Relationships

`CanonicalPageIdentity` is derived from (Source row × ProjectHostContext); entity keys
(`canonicalTechnicalKey`, `canonicalRankKey`, `canonicalCannibalizationPair`) embed the canonical form.
Superseded-key rows retire through the existing opportunity miss/stale lifecycle — no migration table.
