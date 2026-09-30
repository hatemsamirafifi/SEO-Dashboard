# Research: Canonical SEO URL Identity

**Feature**: `006-canonical-url-identity` | **Date**: 2026-09-30

All unknowns resolved via spec clarifications (2026-09-30) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Identity helper placement — extend the chain, keep storage grain frozen

- **Decision**: `canonicalUrl` (`src/shared/intelligence.ts:89`) becomes the full SEO analytical page identity. It keeps delegating path handling to the existing strict path policy (the same code `normalizeGa4LandingPage` in `src/shared/ga4.ts:42` uses), then applies the analytical folds (www/http fold, slash fold, host-context resolution) on top. `normalizeGa4LandingPage` itself is untouched.
- **Rationale**: GA4 sync writes store `landingPage` (normalized path) and `rawLandingPage` (raw) side by side (`ga4SyncNormalize.ts:297-310`), and fact IDs are deterministic over the stored path (`grainKey: page`, `:298-304`). Changing sync normalization would shift stored fact keys and rewrite history. Keeping storage grain frozen while folding at identity-computation time satisfies both the plan's §2.1 "extend the single chain" and the clarified "dedicated helper keeps strict URL semantics untouched" rule.
- **Alternatives considered**: Folding inside `normalizeGa4LandingPage` directly (rejected: rewrites stored GA4 fact keys, changes sync semantics); a second parallel canonicalizer (rejected: Constitution P2/P24, spec FR-001/FR-004).

## Decision 2: Audit `canonicalUrlKey` stays a documented strict exception

- **Decision**: `canonicalUrlKey` (`src/server/lib/audit/url-utils.ts:55`) — which folds www/http but intentionally preserves trailing slashes to avoid a 508 crawl loop (`url-utils.ts:11-17`), used for crawl dedup and Lighthouse homepage picking (`lighthouse.ts:151-157`) — keeps its strict crawl-identity semantics untouched. It is the single documented P24 exception. Cross-source analytical joins of audit-sourced page evidence (e.g. `technicalOnImportantPage.ts:96,137,150`, which already routes through `canonicalUrl`) use the new identity.
- **Rationale**: Verified in code: crawl dedup and analytical joins have genuinely different requirements (redirect-loop safety vs cross-source agreement). The clarified rule explicitly anticipates this split.
- **Alternatives considered**: Unifying audit crawl dedup onto the analytical identity (rejected: slash-fold would reintroduce the documented 508 loop; also changes crawl behavior out of scope).

## Decision 3: Project host context source

- **Decision**: Path-only rows resolve against `projects.domain` (`src/db/app.schema.ts:53`, nullable). The domain value is parsed (strip `sc-domain:` prefix, strip scheme, lowercase) to a bare host before use. When `projects.domain` is null/absent (e.g. auto-created Default project), rows stay path-scoped — never an invented host (spec edge case).
- **Rationale**: Verified to exist; rank-tracking domain configs (`app.schema.ts:215`) corroborate that projects already carry their tracked domain. No new per-project identity configuration.
- **Alternatives considered**: Inferring host from GSC property at join time (rejected: GSC may be disconnected while GA4 is present; host must come from project config, never guessed from data).

## Decision 4: Re-keying needs no backfill

- **Decision**: No migration of stored keys. Findings re-derive per scan (`findingKey` embeds entityKey but is scan-transient identity, `shared/intelligence.ts` identity builders). Opportunities use `logicalKey = detectorKey:entityKey` with active-row uniqueness (`opportunities.schema.ts:24-25,75-76`); after the identity change, superseded-key rows miss subsequent scans and retire automatically via the existing miss/stale lifecycle (`STALE_AFTER_MISSES = 3`, `OpportunityMaterializer.ts:27,77`). The one-time reconciliation required by FR-007 IS this existing mechanism — verified, not assumed.
- **Rationale**: Insert-on-conflict + eventKey-hash idempotency (`materializeFinding.ts:29-86`) plus miss/stale tracking already implement exactly the "retire or re-key without duplicates" behavior.
- **Alternatives considered**: Bounded backfill re-hashing persisted keys (rejected: unnecessary — keys are scan-derived, and the lifecycle already retires stale rows; a backfill would touch the ledger for zero benefit).

## Decision 5: Slash-fold and parse mechanics

- **Decision**: Strip one trailing slash for non-root paths after duplicate-slash collapse; `/` stays `/`. Use the WHATWG `URL` API for full URLs (already used in `url-utils.ts`; hostname auto-lowercases, protocol fold http→https, default `:443`/`:80` ports drop automatically, IDN hosts normalize) and the existing split/leading-slash path branch for path-only rows. Percent-encoding: uppercase hex normalization + decode unreserved characters only; non-ASCII paths never mangled; malformed input degrades to distinct-per-input, never a shared identity.
- **Rationale**: `URL` implements 5 of the 8 clarified rules natively and deterministically in both Workers and Node; remaining rules (slash fold, case-preserved path, sentinel) are the thin analytical layer on top.
- **Alternatives considered**: Hand-rolled regex parser (rejected: IDN/punycode/edge handling would be re-implemented badly); regex-only fold without URL parsing (rejected: inconsistent with `url-utils.ts` precedent).

## Decision 6: Single-helper guard mechanism

- **Decision**: Extend `intelligence-boundaries.test.ts` with an identity review following its existing file-scan pattern: the listed analytical consumers (`AnalyticsJoinService.ts`, detector files using `canonicalUrl`, entity-key builders in `shared/intelligence.ts`) MUST import `canonicalUrl`; no file outside `shared/intelligence.ts`, `shared/ga4.ts`, `server/lib/audit/url-utils.ts` (allowlisted strict exception), and tests may define www/protocol-folding helpers (banned tokens: `replace(/^www\./`, protocol-fold assignments on parsed URLs).
- **Rationale**: Mirrors the proven import-ban/lock pattern already in that file (Stage-1 import ban, no-duplicate-logic scan, structural locks); the audit allowlist is explicit so the guard can't be read as covering crawl code.
- **Alternatives considered**: oxlint `no-restricted-imports` (rejected: import bans cover the wrong axis — the risk is locally-defined folding logic, not imports; file-scan matches house precedent).

## Decision 7: Fixture extension points

- **Decision**: Identity unit suite extends `src/shared/intelligence.test.ts` (incl. all clarified regression pairs); path-semantics regression stays in `src/shared/ga4Normalize.test.ts` (proves the base normalizer unchanged); cross-consumer agreement (sync value → join key → entity key) extends `AnalyticsJoinService.test.ts`.
- **Rationale**: Each suite asserts a distinct invariant (identity folds / base untouched / consumers agree); matches colocated-Vitest house convention.
- **Alternatives considered**: One mega fixture file (rejected: splits the three invariants across their owners, harder to attribute failures).
