# Contract: Canonical Page Identity

**Feature**: `006-canonical-url-identity` | **Date**: 2026-09-30

The single documented identity policy all cross-source page joins share. Consumers: GA4 landing sync
(storage grain — unchanged), `AnalyticsJoinService`, detector/entity-key builders, audit-sourced page
evidence. See [research](research.md), [data model](data-model.md).

## Identity rules (binding)

| Input dimension  | Rule                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scheme           | Fold `http` → `https`; non-http(s) inputs fall back to deterministic pass-through, never a merge                         |
| Host             | Lowercase; fold leading `www.` to bare host; all other subdomains strictly distinct; IDN forms normalize to one identity |
| Port             | Default ports fold with the scheme; non-default ports preserved (distinct identity)                                      |
| Path             | Case preserved; duplicate slashes collapsed; non-root trailing slash folds away; root `/` preserved as root              |
| Query/fragment   | Excluded per the existing shared policy (fragment stripped; query strings stripped for page identity)                    |
| Encoding         | Percent-encoding normalized safely (uppercase hex, unreserved decoded); non-ASCII paths preserved byte-faithful          |
| Blank/query-only | `(not set)` sentinel (existing semantics)                                                                                |
| Path-only rows   | Resolved against `ProjectHostContext`; without host context they stay path-scoped                                        |

## Regression fixture pairs (must-join / must-not-join)

- MUST join: `http://www.example.com/page` ≡ `https://example.com/page/` ≡ `/page` (+ host `example.com`); `/blog` ≡ `/blog/`; `/blog/post` ≡ `/blog/post/`; `/` ≡ root; `/blog?a=1` ≡ `/blog/?a=1`; Arabic path ≡ its percent-encoded form.
- MUST NOT join: `blog.example.com/page` vs `example.com/page`; `example.com:8443/page` vs `example.com/page`; `/Blog` vs `/blog`; `example.com/x` vs `other.com/x`; `(not set)` with anything.

## Consumer agreement

`normalizeGa4LandingPage` output for path-only rows, `AnalyticsJoinService` join keys, and detector
entity keys MUST agree on identity for the same logical page (verified by the cross-consumer agreement
test). GA4 stored `landingPage` values are unchanged; identity folds apply at computation time.

## Guard contract

The extended boundary guard asserts: every listed analytical consumer imports the single identity helper;
no file outside the allowlist (`shared/`, audit `url-utils.ts` strict exception, tests) defines URL
folding; audit crawl behavior is untouched.

## G1 record

Gate G1 is recorded as passed when: the full fixture suite is green, the agreement test is green, the
guard is green, and the consumer audit lists zero bypasses. Cross-source page detectors (010+) may
proceed only after this record.

## Stability promise

Identity rules change only by versioned policy amendment with fixture updates in the same package;
stored rows are never rewritten to match a new policy (recompute from source values instead).
