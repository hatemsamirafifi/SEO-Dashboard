# Feature Specification: Canonical SEO URL Identity

**Feature Branch**: `006-canonical-url-identity`

**Created**: 2026-09-30

**Status**: Implemented — G1 recorded 2026-09-30 (fixture suite 22/22, agreement 5/5, guard 16/16 incl. negative verification, zero consumer bypasses; `pnpm test intelligence` 232/232)

**Input**: User description: "Extend the existing path-only landing-page normalizer into the single canonical SEO URL identity used by every cross-source page join (GA4, GSC, Rank Tracking, SERP, Audit): fold www→bare host and http→https only, preserve all other subdomains and non-default ports, resolve path-only GA4 rows against the project's host context, and prove the identity with a fixture suite (trailing slash, query strings, percent-encoding, subdomains, Arabic paths, cross-domain isolation). Extends normalizeGa4LandingPage→canonicalUrl — no parallel canonicalizer. Ships hard gate G1 (Constitution P24): no cross-source page detector ships before this. Implements Track B milestone B2a of the Final Revised Implementation Plan (PR3, Wave 2)."

## Clarifications

### Session 2026-09-30

- Q: How should near-identical origins (www vs bare host, http vs https) be treated when computing one canonical page identity across sources? → A: SEO-standard fold (binding):
  1. Fold only the conventional origin aliases: `www.example.com → example.com`, `http → https`.
  2. Preserve all other subdomains strictly (`blog.example.com ≠ example.com`).
  3. Preserve non-default ports (`example.com:8443 ≠ example.com`).
  4. Path-only rows (e.g. GA4 landing pages) resolve using the current project's host context before canonicalization.
  5. Continue normalizing: fragments removed, trailing-slash equivalence, duplicate path slashes collapsed, safe percent-encoding normalization, query parameters per the shared canonical policy.
  6. No arbitrary host aliasing beyond www↔bare and http→https.
  7. Keep the original source URL alongside the canonical identity for provenance/debugging.
  8. This is an OpenSEO analytical identity rule; it does not claim Google treats every http/https or www/bare pair as canonical-equivalent in real-world configurations.
- Q: Should trailing-slash variants (`/blog` vs `/blog/`) resolve to the same canonical page identity? → A: Yes — same identity (binding):
  1. Non-root trailing slash normalizes away: `/blog` and `/blog/` → same canonical page; the root path is preserved as root (never an empty path).
  2. Path case stays distinct: `/Blog` ≠ `/blog`.
  3. Other meaningful distinctions preserved: non-www subdomains distinct, non-default ports distinct, query identities per the shared query-parameter policy.
  4. Original source URL kept separately for provenance/debugging.
  5. This is an analytical join identity, not a claim of HTTP/Google canonical equivalence.
  6. Regression pairs required: `/blog` = `/blog/`; `/blog/post` = `/blog/post/`; `/` stays root; `/Blog` ≠ `/blog`; `/blog?a=1` = `/blog/?a=1` after the shared query policy.
  7. The current normalizer's slash-preserving behavior is not kept merely for backward compatibility when it conflicts with this contract; however, where the existing normalizer intentionally serves strict URL semantics elsewhere, it is not silently changed — a dedicated canonical page-identity helper keeps strict URL normalization and SEO analytical identity distinct concepts, and all identity consumers use that single helper.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Same page from different sources joins as one (Priority: P1)

A marketer views intelligence findings that combine GA4 landing pages, GSC pages, and rank-tracking URLs.
The same physical page arrives from each source in a slightly different form (`/blog/post/` with trailing
slash, `https://www.example.com/blog/post`, `http://example.com/blog/post?utm_source=x`). After this feature,
all forms resolve to one canonical identity, so the join treats them as one page — evidence aggregates
instead of splitting into phantom duplicates.

**Why this priority**: G1 is the blocking gate for all cross-source page analysis; every downstream join and
detector (010 organic joins, lost-backlink, content decay corroboration) depends on this identity being
deterministic and shared.

**Independent Test**: Can be fully tested by feeding fixture URL families (alias, subdomain, port, encoding,
Arabic path, cross-domain) through the canonical identity and asserting expected same/different groupings —
no other feature is needed.

**Acceptance Scenarios**:

1. **Given** `http://www.example.com/page`, `https://example.com/page/`, and a GA4 path-only `/page` row for
   a project whose host is `example.com`, **When** each is canonicalized, **Then** all three produce the same
   canonical page identity.
2. **Given** `https://blog.example.com/page` and `https://example.com/page`, **When** both are canonicalized,
   **Then** they produce different identities (subdomains preserved).
3. **Given** `https://example.com:8443/page` and `https://example.com/page`, **When** both are canonicalized,
   **Then** they produce different identities (non-default ports preserved).
4. **Given** `https://example.com/blog/عربي/` (Arabic path) from two sources with different encodings of the
   same path, **When** canonicalized, **Then** they produce the same identity, and no other project's page
   ever collides with it.

---

### User Story 2 - One shared identity, consumed everywhere (Priority: P2)

A developer adds a new join or entity key. Instead of choosing between normalizers, there is exactly one
canonical identity helper, and every existing consumer (GA4 landing sync, cross-source join service, detector
entity keys, audit page keys) already routes through it. A guard test fails the build if any code path
introduces a parallel canonicalizer.

**Why this priority**: The single-helper rule is what makes the identity trustworthy; a second canonicalizer
anywhere would silently fork page identity (Constitution P2, P24).

**Independent Test**: Can be tested by an import/structure guard asserting all page-identity consumers use
the one helper, plus existing consumer test suites passing unchanged on the extended behavior.

**Acceptance Scenarios**:

1. **Given** the codebase after this feature, **When** the identity-guard test scans page-identity call
   sites, **Then** every consumer imports the single shared helper and no parallel canonicalization exists.
2. **Given** the existing GA4 landing sync and join service, **When** they canonicalize the same URL,
   **Then** they produce identical keys (verified by a cross-consumer agreement test).
3. **Given** a source row, **When** it is canonicalized, **Then** the original source URL remains available
   alongside the canonical identity for provenance/debugging.

---

### User Story 3 - Migration without corrupted history (Priority: P3)

An operator upgrades a deployment with stored rows canonicalized under the old path-only rule. Historical
rows remain readable; stored entity keys re-derive deterministically from stored source values (nothing
persisted depends on a stale normalization); and a bounded backfill (if any key-shaped persistence needs
it) runs in batches with project isolation.

**Why this priority**: Correctness of identity is shipped first; safe migration makes it deployable without
regenerating or corrupting existing intelligence history.

**Independent Test**: Can be tested by running the migration/backfill against seeded old-form data and
asserting joins still group correctly and no cross-project rows merge.

**Acceptance Scenarios**:

1. **Given** stored historical rows whose source URLs use www or http forms, **When** identity is recomputed
   from the stored source values, **Then** the result is deterministic and identical across repeated runs.
2. **Given** two projects with the same page path on different domains, **When** their rows are
   canonicalized, **Then** no identity or stored row ever crosses project boundaries.

---

### Edge Cases

- Empty, whitespace-only, or query-only URL values keep the existing "(not set)" sentinel behavior — never
  invented hosts.
- A path-only row with no project host context available cannot be given a host; it stays path-scoped and
  must never inherit an arbitrary or empty host.
- Case sensitivity: hosts are case-insensitive (folded to lowercase); paths keep their case so genuinely
  different paths never merge (existing behavior preserved).
- Percent-encoding: only safe normalization (e.g. uppercase hex, unreserved characters decoded); encoded vs
  unreserved-decoded forms of the same path must agree; non-ASCII paths must not be destroyed.
- Trailing-slash equivalence holds for the analytical page identity: `/blog` and `/blog/` are the same
  canonical page, the root path is preserved as root, and path case stays distinct (`/Blog` ≠ `/blog`).
  Where the existing normalizer intentionally serves strict URL semantics elsewhere, it is not silently
  changed — a dedicated canonical page-identity helper keeps strict URL normalization and SEO analytical
  identity distinct concepts.
- URLs that are not valid absolute URLs and are not valid paths are passed through with deterministic,
  documented behavior rather than throwing.
- A fold must never change the domain: `www.example.com` folding must never collide with a distinct domain
  that happens to share a suffix.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST compute one canonical page identity per source URL by extending the existing
  path-only normalizer chain — the identity MUST fold `www.` to the bare host and `http` to `https`, and
  MUST NOT fold any other subdomain, port, or alias.
- **FR-002**: Path-only source rows (such as GA4 landing pages) MUST be resolved to a full identity using
  the current project's host context before canonicalization; when no host context exists they MUST remain
  path-scoped and MUST NOT be given an invented host.
- **FR-003**: Canonicalization MUST be deterministic and MUST include: fragment removal, query-parameter
  handling per the shared canonical policy, trailing-slash equivalence (a non-root trailing slash normalizes
  away so `/blog` and `/blog/` share one identity; the root path is preserved as root), duplicate-slash
  collapsing, and safe percent-encoding normalization — with case-insensitive hosts and case-preserved
  paths (path case stays distinct: `/Blog` ≠ `/blog`).
- **FR-004**: The canonical identity helper MUST remain the single implementation: all page-identity
  consumers (GA4 landing sync, cross-source joins, detector/entity-key builders, audit page keys) MUST
  consume it, and a guard test MUST fail if a parallel canonicalizer is introduced.
- **FR-005**: The original source URL MUST be preserved alongside the canonical identity wherever rows are
  joined or persisted, for provenance and debugging.
- **FR-006**: The identity MUST be proven by a fixture suite covering at minimum: www/http alias fold,
  subdomain preservation, non-default port preservation, trailing-slash equivalence (`/blog` = `/blog/`,
  root preserved as root, path case distinct), query strings, percent-encoding (including Arabic paths),
  path-only resolution, "(not set)" sentinels, and cross-domain isolation (no
  two different domains may ever produce the same identity).
- **FR-007**: Any bounded backfill of stored identity-shaped values MUST be batched, project-isolated, and
  idempotent; recomputation from stored source values MUST be deterministic.
- **FR-008**: The feature MUST record the G1 gate as satisfied (canonical URL identity exists and is
  enforced by tests) so cross-source page detectors (010, and any later page-grain detector) may proceed.

### Key Entities

- **CanonicalPageIdentity**: The deterministic full URL identity (scheme, host, port, normalized path) that
  all cross-source page joins share; derived from any source URL or path-only row plus project host context.
- **ProjectHostContext**: The project's host context used to resolve path-only rows; derived from project
  configuration, never guessed from data.
- **SourceUrl (provenance)**: The original, unmodified URL stored alongside the canonical identity.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every fixture family in the identity suite (aliases fold; subdomains/ports distinct;
  encoding, Arabic, trailing-slash, query cases; cross-domain isolation) passes with 100% deterministic
  groupings — two runs of the same suite produce identical identities.
- **SC-002**: A cross-consumer agreement check shows zero disagreements on page identity between GA4
  landing sync, the join service, and detector entity keys across the seeded corpus.
- **SC-003**: The identity guard test finds zero page-identity call sites bypassing the shared helper, and
  deliberately introducing a bypass in a scratch build fails the guard.
- **SC-004**: For a seeded mixed-source corpus, the number of distinct joined pages equals the number of
  physically distinct pages (no phantom duplicates from www/http/slash variants; no false merges across
  subdomains, ports, or domains).

## Assumptions

- The existing path-only normalizer and its "(not set)" sentinel semantics are the baseline being extended;
  current consumers keep compiling with the new behavior via the same call sites.
- Query parameters are stripped for page identity by the existing shared policy (UTM variants of one page
  collapse to one row); this feature does not introduce selective query preservation.
- Trailing-slash equivalence for page joins is adopted per the clarified rule; the canonical identity
  helper defines the single decision (non-root slash folds away, root preserved, path case distinct), and
  where the existing normalizer intentionally serves strict URL semantics elsewhere it stays untouched —
  the dedicated identity helper keeps the two concepts distinct.
- Host context comes from the project's existing configuration surfaces; no new per-project identity
  configuration is added.
- No new detector, join, or UI ships inside this package — those are gated consumers (010 et al.) that
  consume this identity after G1 is recorded.
- GA4 data model, sync semantics, and coverage ledgers are untouched; only the page-identity derivation
  inside existing consumers changes.
- SERP and backlink domain-level identity (domain grain) is out of scope; this feature is page-grain.
