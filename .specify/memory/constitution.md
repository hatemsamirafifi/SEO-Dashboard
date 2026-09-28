<!-- Sync Impact Report (temporary — remove before commit)
Version change: scaffold (unversioned template) → 1.0.0 (initial ratification)
Modified principles: none (initial adoption; 50 principles ratified as new)
Added sections: Articles I–XX (Principles 1–50), Appendices A–C, Preamble, Amendment & Precedence
Removed sections: generic template placeholders ([PROJECT_NAME], [PRINCIPLE_N_*], [SECTION_*], [GOVERNANCE_RULES])
Follow-up TODOs: none — all placeholders resolved; dates ISO 2026-09-28; version line verified.
-->

# OpenSEO Constitution

**Project:** OpenSEO  
**Document Type:** Engineering Constitution  
**Version:** 1.0.0  
**Ratified:** 2026-09-28  
**Last Amended:** 2026-09-28  
**Status:** Authoritative

---

## Preamble

This Constitution defines the non-negotiable engineering principles, architectural boundaries, data semantics, safety rules, and governance model for OpenSEO.

It is intended to guide maintainers, contributors, coding agents, SAM, MCP tooling, and implementation plans.

When an implementation plan, ticket, prompt, agent suggestion, or code change conflicts with this Constitution, **the Constitution wins** unless it is formally amended.

OpenSEO is an open-source SEO intelligence platform designed to provide Semrush/Ahrefs-class workflows while remaining:

- transparent,
- cache-first,
- cost-aware,
- provider-independent at the product layer,
- safe for human and autonomous-agent use,
- self-hostable,
- and structurally consistent across SQLite/D1 and PostgreSQL.

The platform should help users:

```text
Measure
→ Observe
→ Diagnose
→ Prioritize
→ Fix
→ Monitor
→ Prove Improvement
```

without fabricating certainty or hiding provider/data limitations.

---

# Article I — Core Architectural Law

## Principle 1 — Preserve the Established Application Layers

All feature logic MUST follow the established application flow:

```text
Client / MCP / Workflow
→ Server Function or approved server entrypoint
→ Feature Service
→ Repository
→ Database / Provider / Cache abstraction
```

### Mandatory rules

1. Server Functions enforce:
   - authentication,
   - project context,
   - strict input validation,
   - feature-service delegation.

2. Services own:
   - orchestration,
   - business rules,
   - provider coordination,
   - precedence rules,
   - normalized domain logic.

3. Repositories own persistence only.

4. React components MUST NOT:
   - call DataForSEO directly,
   - parse raw provider payloads,
   - implement business rules that belong in Services.

5. MCP handlers MUST remain thin adapters over the same Services used by the UI.

6. Workflows and SAM MUST reuse the same service contracts and safeguards rather than creating parallel implementations.

---

## Principle 2 — No Competing Architecture

OpenSEO MUST NOT introduce a second implementation of an existing platform concern.

The following are explicitly prohibited unless this Constitution is amended:

- second Intelligence Engine,
- second SERP resolver,
- second generic job/queue engine,
- alternate provider-routing framework,
- duplicate URL canonicalization systems,
- duplicate scoring engines for the same opportunity model,
- direct provider implementations in UI or MCP layers.

When a subsystem already exists, new work MUST extend it.

---

# Article II — Database & Persistence Law

## Principle 3 — SQLite/D1 and PostgreSQL Parity Is Mandatory

Every schema change MUST preserve structural parity between:

```text
SQLite / D1
PostgreSQL
```

Changes must mirror:

- tables,
- columns,
- primary keys,
- foreign keys,
- unique constraints,
- indexes,
- defaults,
- logical semantics.

### Required validation

Schema parity tests MUST pass before a database change is considered complete.

---

## Principle 4 — Repository-Only Database Access

Feature Services MUST NOT directly perform persistence logic that belongs in repositories.

Repositories MUST import the canonical schema/database abstractions used by the project.

Database writes MUST use the approved batching utilities:

```text
runBatch
executeInBatches
```

Direct use of:

```text
db.batch
```

is prohibited.

---

## Principle 5 — Migrations Must Be Additive and Safe

New migrations SHOULD be additive whenever practical.

Destructive changes require:

- explicit migration strategy,
- rollback reasoning,
- D1/Postgres parity,
- data preservation review.

Backfills MUST:

- be bounded,
- use batching helpers,
- avoid long-running unbounded transactions,
- preserve project isolation.

---

# Article III — Provider & Data Integrity Law

## Principle 6 — No New SEO Provider Without Explicit Product Decision

The approved SEO/provider set is:

- DataForSEO
- Serper.dev
- Zenserp
- Google Search Console
- Google Analytics 4
- Google Ads where already supported
- Bing Webmaster where already supported
- OpenSEO local crawler
- Lighthouse
- existing internal OpenSEO data

No new SEO provider may be introduced as an implementation shortcut.

---

## Principle 7 — Provider-Independent Product Model

The product UI and domain model MUST expose SEO capabilities, not provider-specific product silos.

Examples:

Preferred:

```text
SERP Analysis
Keyword Research
Backlink Intelligence
Local Results
SERP Features
```

Avoid:

```text
Serper Tool
Zenserp Tool
DataForSEO Tool
```

Provider provenance may be shown through source badges and diagnostics.

---

## Principle 8 — Provider Failure Must Never Become a Valid SEO Fact

This is a critical invariant.

A provider or API failure MUST NOT be translated into:

```text
0
no result
not ranking
no backlinks
no traffic
no opportunity
no keyword difficulty
```

unless the provider successfully returned data proving that state.

### Examples

Correct:

```text
provider failure
→ unavailable
```

Correct:

```text
provider explicitly returns backlinks = 0
→ 0
```

Incorrect:

```text
provider failure
→ backlinks = 0
```

The same rule applies to:

- rankings,
- keyword difficulty,
- backlinks,
- referring domains,
- traffic,
- SERP metrics,
- opportunities,
- GA4/GSC coverage.

---

## Principle 9 — Zero, Missing, and Failed Are Different States

OpenSEO MUST preserve the distinction between:

```text
0
null / missing
failed / unavailable
```

No generic coercion such as the following is allowed where it destroys semantics:

```ts
value || 0
Number(value) || 0
```

Nullable provider values SHOULD remain nullable unless the provider contract explicitly defines otherwise.

---

# Article IV — DataForSEO Error Semantics

## Principle 10 — DataForSEO Error Classification Is Deterministic

The following provider task codes have distinct meanings and MUST NOT be conflated.

### 40201

```text
DATAFORSEO_ACCESS_PAUSED
```

or the existing equivalent account-paused classification.

This classification is reserved for status code `40201`.

### 40200

```text
CREDITS_UNAVAILABLE
```

or the established billing/payment classification.

It MUST NOT be classified as account paused.

### 40210

```text
INSUFFICIENT_FUNDS
```

or the established equivalent.

### Retry rule

Permanent account/billing/configuration failures MUST NOT be blindly retried.

Only transient provider failures may use the configured retry policy.

---

# Article V — Cache, Cost & Paid-API Law

## Principle 11 — OpenSEO Is Cache-First and Free-First

The intended resolution order remains:

```text
Cache
→ Free / First-Party Source
→ Internal Stored Data
→ Paid Provider Fallback
```

Paid provider calls MUST be treated as controlled resources.

---

## Principle 12 — Every Paid Path Must Be Bounded

Paid API features MUST use, where applicable:

- R2/SeoCacheService,
- deterministic cache keys,
- singleFlight/request coalescing,
- daily/monthly budget guards,
- provider circuit breaker,
- retry policy,
- batching,
- deduplication,
- trace/cost observability.

N+1 provider patterns are prohibited when a bulk endpoint exists.

---

## Principle 13 — Rendering Must Not Cause Hidden Paid Work

Dashboard, Reports, SAM views, and standard page rendering MUST NOT silently trigger paid provider calls.

Paid work is allowed only through:

- scheduled sync/workflow paths,
- explicit manual refresh actions,
- explicitly designed provider enrichment flows with documented cost guards.

---

# Article VI — SERP Intelligence Law

## Principle 14 — One Normalized SERP Model

All SERP providers MUST normalize into one internal SERP representation.

Downstream components MUST NOT depend on raw provider JSON.

The normalized model should support, where available:

- organic results,
- featured results,
- People Also Ask,
- related searches,
- local pack,
- images,
- videos,
- shopping,
- news,
- knowledge graph,
- sitelinks,
- provider status,
- checked timestamp,
- market/device context.

---

## Principle 15 — SERP Competitive Enrichment Is Top-10 by Default

Automatic competitive enrichment is limited to:

```text
Top 10 organic results
```

Results outside the Top 10 MUST NOT automatically trigger paid backlink/rank enrichment.

Expansion beyond Top 10 requires an explicit future product action.

---

## Principle 16 — Competitive Metrics Must Use Accurate Names

OpenSEO MUST NOT fabricate or imitate proprietary third-party metrics.

Do not label DataForSEO metrics as:

- DA
- PA
- DR
- TF
- CF

Use provider-accurate names such as:

- DataForSEO Domain Rank
- DataForSEO Page Rank
- Referring Domains
- Backlinks
- provider-supported Spam/Risk
- Estimated Traffic where actually available

---

## Principle 17 — SERP Enrichment Must Be Bulk, Cached, and Merge by Identity

Top-10 enrichment MUST:

1. canonicalize URLs/domains,
2. dedupe targets,
3. use supported bulk endpoints,
4. cache reusable target metrics,
5. merge by normalized identity,
6. tolerate missing/partial provider results.

Provider response array order MUST NOT be used as identity.

Base SERP results MUST remain visible if enrichment fails.

---

# Article VII — Keyword Difficulty Law

## Principle 18 — Preserve Raw Keyword Difficulty Semantics

DataForSEO keyword difficulty values are preserved exactly:

```text
0 → 0
null → null / —
nonzero → same value
```

No custom KD formula replaces provider KD in the existing Keyword Research metric.

---

## Principle 19 — Snapshot Time and Fetch Time Are Different

The following are semantically distinct:

```text
providerSnapshotDate
fetchedAt
```

`providerSnapshotDate` means the provider’s underlying SERP snapshot date.

`fetchedAt` means when OpenSEO retrieved the metric.

OpenSEO MUST NOT infer SERP freshness merely because a metric was fetched recently.

---

## Principle 20 — Manual Bulk KD Override Is Bounded

A manually refreshed Bulk KD may override embedded Labs KD only within the configured bounded override window.

Current policy:

```text
REFRESHED_KD_OVERRIDE_TTL_DAYS = 90
```

This is an override-precedence window, not SERP freshness.

Expired manual values remain stored historically but cease to override current Labs values.

---

# Article VIII — GSC & GA4 Semantics

## Principle 21 — Zero-Row Success Is Not Failure

For GSC and GA4 stored synchronization:

```text
successful API response with zero rows
```

must remain distinguishable from:

```text
API failure
```

Coverage ledgers/status must represent successful zero-row days explicitly where the integration supports that distinction.

---

## Principle 22 — GSC Finalization Is Heuristic

The GSC API does not provide a deterministic finalized flag.

Any latency rule such as `today - 3 days` is a heuristic and MUST NOT be presented as a guaranteed finalization boundary.

---

## Principle 23 — GA4 Non-Additive Metrics Must Stay Non-Additive

Metrics such as distinct users MUST NOT be summed across periods/grains where doing so creates false totals.

Ratios and derived metrics should be calculated from appropriate aggregate numerators/denominators.

---

# Article IX — URL Identity Law

## Principle 24 — Cross-Source Page Analysis Requires Canonical URL Identity

Before GA4, GSC, Rank Tracking, Audit, or SERP page-level data are joined, the system MUST use one canonical URL identity strategy.

Canonicalization must be deterministic and tested.

Different canonicalizers for different features are prohibited unless their differences are explicitly required and documented.

---

# Article X — Intelligence & Opportunities Law

## Principle 25 — One Intelligence Engine

All deterministic SEO detection belongs to the existing Intelligence Engine.

Do not create parallel detector systems inside:

- Dashboard,
- Reports,
- SERP UI,
- SAM,
- MCP.

Those surfaces consume stored Findings, Insights, Opportunities, or normalized evidence.

---

## Principle 26 — Impact and Confidence Are Separate

Opportunity scoring MUST preserve the distinction between:

```text
impactScore
confidenceScore
```

Do not collapse them into an opaque single proprietary ranking score.

Missing optional inputs should use established available-factor renormalization rather than being treated as zero.

---

## Principle 27 — Facts and Recommendations Are Different

Detectors produce evidence/facts.

Recommendations come from the approved materialization/template layer.

UI and reports must distinguish:

```text
what happened
```

from:

```text
what OpenSEO recommends doing
```

---

## Principle 28 — Provider Failure Cannot Create an Opportunity

A detector MUST NOT trigger merely because its input source failed or is unavailable.

Insufficient coverage, partial data, and provider failure require explicit no-trigger/partial semantics.

---

# Article XI — Dashboard Law

## Principle 29 — Dashboard Is a Stored Intelligence Surface

The Dashboard may aggregate:

- GSC,
- GA4,
- Rank Tracking,
- Opportunities,
- Insights,
- Audit,
- Backlinks,

but must use stored/service-backed data.

Dashboard rendering MUST NOT become a provider-fetch orchestration layer.

---

## Principle 30 — Dashboard Sections Use Explicit Data States

Dashboard sections must distinguish at least:

- loading
- ready
- empty
- not connected
- no data
- partial
- stale
- API failure
- permission failure
- sync running
- sync failed

Failure must not render as zero.

---

# Article XII — Reports Law

## Principle 31 — Reports Are Immutable Snapshots

Generated reports must preserve:

- frozen payload,
- source provenance,
- branding snapshot,
- consistency state.

Reports do not recalculate historical sections from live provider data when viewed later.

---

## Principle 32 — Raw Share Tokens Are Never Persisted

Share tokens must remain hash-only at rest.

Raw tokens may exist only at creation/delivery time and must not be stored in report schedules or public metadata.

---

## Principle 33 — Scheduled Reports Must Be Idempotent

Scheduled report execution requires a deterministic logical identity such as:

```text
(scheduleId, scheduledFor)
```

Cron re-entry or retries must not generate/send the same scheduled report multiple times.

A durable schedule-run ledger is required.

---

# Article XIII — SAM Autopilot Law

## Principle 34 — Autopilot Is an Orchestrator, Not a Source of Truth

SAM Autopilot operates over frozen/stored evidence.

It must not become the place where core SEO facts, scores, gaps, or opportunities are invented independently.

---

## Principle 35 — Autopilot Must Be Bounded

Autopilot workflows must use:

- explicit workflow allowlists,
- bounded steps,
- bounded tool calls,
- resumable attempts,
- durable step history,
- idempotency,
- frozen source versions.

No generic unconstrained autonomous agency is allowed.

---

## Principle 36 — Competitor Gap Requires Proven Inputs

Competitor-gap detectors/workflows may ship only after a dedicated input/cost/reliability spike proves the supporting data is trustworthy and economical.

---

# Article XIV — Background Execution Law

## Principle 37 — Keep Cloudflare-Native Execution

Use the existing:

- scheduled worker,
- Cloudflare Workflows,
- Durable Objects,

rather than adding a new generic queue/job engine.

Long-running features should reuse existing execution infrastructure.

---

# Article XV — Security Law

## Principle 38 — Credentials Must Remain Encrypted and Scoped

Provider/OAuth credentials must:

- be encrypted at rest,
- respect project/org/environment scope,
- never be returned in plaintext to clients,
- never be logged,
- never appear in Global Trace.

---

## Principle 39 — Project Scope Is Mandatory

All project-bound server functions, services, MCP tools, report operations, goals, schedules, and Autopilot actions must validate project/organization access.

No cross-project data leakage is acceptable.

---

## Principle 40 — Public Sharing Uses a Separate Trust Boundary

Public report routes may expose only explicitly shareable report data.

They must never expose:

- credentials,
- internal provider payloads,
- private notes not intended for sharing,
- raw share tokens,
- unrelated project data.

---

# Article XVI — Observability Law

## Principle 41 — Global Trace Is Required for Major Operations

Major operations should emit trace data appropriate to their domain, including where relevant:

- feature,
- operation,
- provider,
- cache status,
- status code/class,
- counts,
- duration,
- cost/budget metadata.

Trace must not contain secrets.

---

## Principle 42 — Durable Ledgers Remain Authoritative

Global Trace is an observability surface.

It does not replace durable ledgers such as:

- sync ledgers,
- intelligence runs,
- opportunity events,
- report events,
- Autopilot steps.

---

# Article XVII — Testing Law

## Principle 43 — TDD Is Preferred for Behavioral Changes

Behavioral changes should begin with failing tests when practical.

At minimum, every new subsystem behavior must include regression tests for its critical invariants.

---

## Principle 44 — Mandatory Verification Categories

Changes must include relevant tests from these categories:

### Unit
- deterministic policies,
- normalization,
- freshness,
- scoring,
- error classification.

### Repository
- project/market isolation,
- upsert behavior,
- unique constraints,
- D1/PG parity.

### Service
- provider failure,
- partial data,
- retry semantics,
- precedence,
- idempotency.

### UI
- loading,
- partial,
- unavailable,
- failure,
- responsive behavior.

### E2E
When the feature crosses multiple major boundaries.

---

## Principle 45 — Required Quality Gates

Relevant implementation work must pass:

```text
pnpm types:check
pnpm oxlint
```

and applicable test suites.

A feature is not READY while required tests, typecheck, lint, or schema parity are failing.

---

# Article XVIII — Product Truthfulness Law

## Principle 46 — OpenSEO Must Not Overstate Certainty

The product must clearly distinguish:

- observed fact,
- first-party data,
- third-party estimate,
- provider snapshot,
- OpenSEO-calculated value,
- recommendation,
- unavailable data.

Examples:

```text
Estimated Traffic
```

must not be presented as actual GA4 traffic.

A GSC absence must not automatically be described as proof that a page is not indexed.

Correlation must not be written as causation.

---

## Principle 47 — Provenance Should Be Available

Major SEO metrics should expose, where practical:

```text
Source
Data Type
Freshness / Snapshot Context
```

Recommended data classifications:

```text
FIRST_PARTY
THIRD_PARTY_ESTIMATE
SERP_OBSERVED
CRAWLER_OBSERVED
OPENSEO_CALCULATED
```

---

# Article XIX — Implementation Governance

## Principle 48 — Repository Discovery Precedes Assumption

Before implementing a significant feature, agents must inspect the actual codebase.

Plans and prompts are guides, but live repository contracts are authoritative for:

- filenames,
- existing abstractions,
- schemas,
- endpoint wrappers,
- type models,
- tests.

Do not create duplicate infrastructure because a planning document was incomplete.

---

## Principle 49 — Architecture Changes Require Evidence

If implementation reveals a genuine contradiction in the repository, the agent may propose a change.

It must state:

1. the actual conflicting code,
2. why the current plan cannot be implemented safely,
3. the smallest architectural correction,
4. migration/testing implications.

Do not reopen settled architecture without concrete repository evidence.

---

## Principle 50 — Scope Discipline

A bounded feature must remain bounded.

Do not add unrelated:

- providers,
- routes,
- tables,
- queues,
- detectors,
- scoring systems,
- UI redesigns,

unless they are necessary for the accepted feature and explicitly justified.

---

# Article XX — Amendment & Precedence

## 20.1 Precedence

In case of conflict, the order of authority is:

```text
1. OpenSEO Constitution
2. Explicit user-approved architectural decision
3. Final Revised Implementation Plan
4. Feature specification / approved implementation prompt
5. Existing documentation
6. Agent assumptions
```

The live repository remains authoritative for facts about what currently exists.

If repository reality contradicts a plan, the contradiction must be surfaced rather than silently resolved.

---

## 20.2 Amendments

A constitutional amendment must:

1. identify the principle being changed,
2. explain why the existing rule is insufficient,
3. describe compatibility/migration effects,
4. update the Constitution version,
5. update the ratification/amendment record.

Minor wording clarifications may increment the patch version.

New rules or material behavioral changes increment the minor version.

Breaking architectural changes increment the major version.

---

## 20.3 Compliance Review

Before a major PR is marked READY, verify:

- architecture layering,
- project scoping,
- database parity,
- provider semantics,
- cache/cost protections,
- failure≠zero invariants,
- security,
- trace coverage,
- required tests,
- no prohibited parallel architecture.

---

# Appendix A — Current Hard Gates

The following gates are binding:

```text
G1  Canonical URL identity before cross-source page detectors.
G2  GA4 stored foundation before GA4-backed detectors.
G3  Existing Opportunity model remains the single intelligence model.
G4  Existing normalized SERP contract before competitive enrichment.
G5  Competitor-gap requires an input spike.
G6  Scheduled email reports require delivery-infrastructure verification.
G7  No raw report share-token persistence.
G8  No SERP N+1 enrichment.
G9  Provider failure never becomes zero/no-result.
G10 Dashboard, Reports, and SAM do not perform render-time paid provider reads.
```

---

# Appendix B — Current Approved Execution Tracks

```text
Track A — Dashboard Intelligence
Track B — GA4 Data Foundation
Track C — Opportunities / Intelligence
Track S — SERP Intelligence & Competitive Metrics
Track D — Reports & Agency
Track E — SAM Autopilot
```

Global Trace and MCP are cross-cutting.

---

# Appendix C — Constitutional Definition of READY

A feature may be declared:

```text
READY
```

only when:

- implementation matches the approved scope,
- critical invariants are preserved,
- tests pass,
- typecheck passes,
- lint passes,
- required database parity passes,
- known provider failures are handled explicitly,
- remaining blockers are external rather than hidden code defects.

If a live provider smoke test is blocked by an external account condition, READY is allowed only when:

- automated coverage validates the code path,
- failure classification is correct,
- existing data remains preserved,
- no corruption or false zero/no-result is written,
- the external blocker is clearly documented.

---

**End of Constitution**

**Version**: 1.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-09-28
