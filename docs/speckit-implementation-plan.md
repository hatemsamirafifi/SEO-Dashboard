# OpenSEO Final Revised Plan — SpecKit Implementation Plan

> Source: `C:\Users\HaTeM\Downloads\OpenSEO_Final_Revised_Implementation_Plan.md` (25 sections, 21 PRs, 5 waves, 10 gates).
> Constitution: `.specify/memory/constitution.md` v1.0.0 (authoritative on conflict).
> Status: **Reviewed 2026-09-28. Ready to execute as SpecKit specs.** Nothing below has been implemented.
> Convention: one SpecKit feature per package below → `specs/<NNN>-<name>/{spec.md,plan.md,tasks.md}` via
> `/speckit.specify` → `/speckit.plan` → `/speckit.tasks`. Templates: `.specify/templates/`.

---

## 1. Plan review verdict

**Verdict: APPROVED with corrections.** The plan's governing principle (extend, don't rebuild) holds up against
the live repo. Its 10 hard gates are already ratified as Constitution Appendix A G1–G10. The parallel
track structure (A/B/C/S/D/E) is sound. The corrections in §2 are binding clarifications, not redesigns.

### 1.1 What verified TRUE against the repo (evidence)

| Plan claim                                       | Evidence                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intelligence Engine exists with detectors        | `src/server/features/intelligence/detectors/` — 8 detectors registered in `registry.ts` (ga4OrganicChange, organicTrafficChange, lowCtrQuery, contentDecay, rankingDrop, cannibalization, technicalOnImportantPage, backlinkChange)   |
| Opportunities + insights persisted               | `src/db/opportunities.schema.ts`, `src/db/insights.schema.ts`, `src/db/intelligence.schema.ts` (+ `pg/` mirrors, parity-tested)                                                                                                       |
| GA4 stored foundation exists                     | `src/db/ga4.schema.ts`: `ga4_connections`, `ga4_daily_summary/acquisition/landing_pages/events`, `ga4_syncs`; services `Ga4Service.ts`, `Ga4SyncService.ts`, `scheduledGa4Sync.ts`                                                    |
| SERP resolver exists, no enrichment              | `src/server/features/serp/{types,resolverCore,providerResolver,httpProviders,circuitBreaker,retryPolicy}.ts`; **no** `SerpSnapshot`, **no** `getSerpCompetitiveMetrics`                                                               |
| Dashboard / Reports / Autopilot services exist   | `dashboard/services/DashboardService.ts`, `reports/services/{ReportService,ShareService,BrandingService,ExportService}.ts`, `autopilot/services/AutopilotService.ts` + step executor                                                  |
| Boundary guards exist                            | `src/server/features/intelligence/intelligence-boundaries.test.ts` (forbids `rankScore`, `causedBy`, `finding_samples`, `report_schedules` — see §2.4)                                                                                |
| Striking distance is helper-only, not a detector | `gsc/searchPerformanceReport.ts` has striking-distance rows (positions 5–20); **no** striking-distance detector in `registry.ts` → C1 is real new work                                                                                |
| Canonicalizer is path-only today                 | `shared/intelligence.ts:canonicalUrl()` delegates to `normalizeGa4LandingPage()` (`shared/ga4.ts`), which normalizes **paths** — not full cross-source URL identity (scheme/host/subdomain/encoding) → B2a is real new work, see §2.1 |

### 1.2 What's genuinely new (greenfield deltas)

- `ga4_daily_geo`, `ga4_daily_technology`, `ga4_project_goals` tables (B1/B2c) — confirmed absent.
- Full canonical SEO URL identity incl. host handling (B2a) — extension of path normalizer, not a new system.
- Striking-distance detector (C1), lost-backlink opportunity split (C2a), GA4 conversion/engagement detectors (C2b/C2c).
- SERP Track S almost in full (S0–S12): normalized snapshot hardening, Top-10 bulk enrichment, feature normalization, cache, trace.
- `report_schedules` + `report_schedule_runs` (D2b) — new schema, gated on D2a spike.
- SAM workflows E1a–E1d + chat orchestration E2.

---

## 2. Binding review corrections (apply during spec authoring)

### 2.1 [B2a] Extend the existing normalizer — do not fork it

`canonicalUrl()` (`src/shared/intelligence.ts:78`) already delegates to `normalizeGa4LandingPage()`.
The spec MUST require extending that single chain (add scheme/host/subdomain/percent-encoding handling +
tests incl. trailing-slash, query-string, encoded paths, subdomain preservation, Arabic paths,
no cross-domain collisions) rather than creating a parallel canonicalizer. Constitution Principle 2 /
G1 applies. All of GA4 landing sync (`ga4SyncNormalize.ts`), joins (`AnalyticsJoinService.ts`), and entity-key
builders must consume the same function.

### 2.2 [C1] Reconcile the position band with the existing helper

The existing GSC helper uses positions **5–20** (`searchPerformanceReport.ts:78`); the plan specifies
**11–20** for the new detector. The spec MUST pick one band with rationale, keep the helper and the detector
consistent (or document why they differ), and define the impressions floor + coverage gating
(no-trigger on insufficient impressions, incomplete coverage, failed/unavailable rank).

### 2.3 [S0] Discovery spike is mandatory, with a file inventory

S0 must document the actual path `Keyword Research → getSerpAnalysis / get_serp_results → resolver →
DataForSEO/Serper/Zenserp → normalized output` starting from `src/server/features/serp/` and the MCP
`get_serp_results` handler. G4 blocks all enrichment implementation until the normalized contract
(`SerpSnapshot` shape adapted to repo conventions) is frozen. No second resolver, no raw provider
parsing in React, no fake DA/PA/DR/TF/CF (Constitution Principles 14–17).

### 2.4 [D2b] Boundary test must be updated in the same PR

`intelligence-boundaries.test.ts:69` currently asserts `report_schedules` does not exist.
The D2b spec MUST include updating that allowlist as part of the change, plus:
`UNIQUE(scheduleId, scheduledFor)`, hash-only share references (`shareId`, never raw `shareToken` —
Constitution Principle 32 / G7), weekly+monthly MVP cadence, existing scheduled infrastructure only.

### 2.5 [A0 vs B1] Contract-first to avoid wave-1 collision

Wave 1 runs Dashboard rollups (A0) in parallel with GA4 geo/tech (B1). A0 aggregates GA4 data, so its spec
MUST define the read contract (service method signatures + `DataSectionState` mapping) first and code
against GA4-gated empty states until B1 lands — never block A0 on B1's tables, never read B1 tables directly.

### 2.6 [E1d/C2e] Conditional — do not schedule as normal work

Competitor-gap detector/workflow ships **only** if spike C2d passes (G5). Its spec package stays
`Draft` until the go/no-go is recorded. Same for SERP-beyond-Top-10, historical SERP trends, and
auto MCP enrichment (Later list, §21 of source plan).

### 2.7 Test strategy: extend, don't recreate

Colocated Vitest, `schema-parity.test.ts`, `ga4Migration.test.ts`, `intelligence-boundaries.test.ts`,
detector fixture tests, and Playwright `e2e/` all exist. Each spec's acceptance criteria MUST name the
exact test files to extend (see per-package tables) and the quality gate
`pnpm types:check` + `pnpm oxlint` + parity (Constitution Principles 43–45).

---

## 3. SpecKit package map (12 features ← 21 PRs)

Each row is one `/speckit.specify` run. Order follows source-plan §19 waves / §24 execution order.
`Gate` = hard gate that must be satisfied before the package's implementation tasks begin.

| #   | Spec dir                                | Source PRs                               | Track | Gate                                     | Wave             |
| --- | --------------------------------------- | ---------------------------------------- | ----- | ---------------------------------------- | ---------------- |
| 001 | `specs/001-dashboard-stored-rollups/`   | PR1 (A0)                                 | A     | G9, G10                                  | 1                |
| 002 | `specs/002-ga4-geo-tech-grains/`        | PR2 (B1)                                 | B     | G9                                       | 1                |
| 003 | `specs/003-serp-contract-discovery/`    | PR5 (S0–S1)                              | S     | **G4** (produces the freeze it gates on) | 1                |
| 004 | `specs/004-striking-distance-detector/` | PR8 (C1)                                 | C     | G3                                       | 1                |
| 005 | `specs/005-reports-share-hardening/`    | PR14 (D1)                                | D     | G7                                       | 1                |
| 006 | `specs/006-canonical-url-identity/`     | PR3 (B2a)                                | B     | **G1** (ships the gate)                  | 2                |
| 007 | `specs/007-serp-top10-enrichment/`      | PR6 (S2–S3, S6–S8, S10, S12)             | S     | G4 (needs 003), G8, G9                   | 2                |
| 008 | `specs/008-lost-backlink-opportunity/`  | PR9 (C2a)                                | C     | G3, G9                                   | 2                |
| 009 | `specs/009-email-delivery-spike/`       | PR15 (D2a)                               | D     | **G6** (go/no-go output)                 | 2                |
| 010 | `specs/010-ga4-joins-goals-detectors/`  | PR4 + PR10 + PR11 (B2b/B2c, C2b/C2c, C3) | B+C   | G1 (needs 006), G2                       | 3–4              |
| 011 | `specs/011-serp-features-ui/`           | PR7 (S4–S5, S9) + PR12/13 (A1–A2)        | S+A   | G4, G10                                  | 3–4              |
| 012 | `specs/012-scheduled-reports/`          | PR16 (D2b)                               | D     | G6 (needs 009 = READY)                   | 3, conditional   |
| 013 | `specs/013-autopilot-workflows/`        | PR17 + PR18 + PR21 (E1a–E1c, E2)         | E     | G10                                      | 3–5              |
| 014 | `specs/014-competitor-gap-conditional/` | PR19 → PR20 → E1d (C2d/C2e)              | C+E   | **G5**, stays Draft until spike passes   | 4–5, conditional |

> 14 packages, not 12 — the two conditional spikes (009, 014) are kept separate so a BLOCKED
> verdict halts only its downstream package, never the whole program.

### Per-package scope, key files, acceptance

#### 001 — Dashboard stored rollups (PR1 · A0)

- **Scope:** extend `DashboardService.getOverview` over stored GSC/GA4/Rank/Opportunities/Insights/Audit/Backlinks;
  current-vs-previous windows; source/coverage metadata. Read-only; no provider calls (G10).
- **Key files:** `src/server/features/dashboard/services/DashboardService.ts`, `src/serverFunctions/dashboard.ts`,
  `src/server/features/gsc/searchPerformanceReport.ts` (previous-period helpers).
- **Tests:** extend `DashboardService.test.ts`; failure-never-zero cases; project-scope rejection.
- **Accept:** project-scoped; equivalent-period deltas; coverage badges; failure renders unavailable, never 0.

#### 002 — GA4 geo/tech grains (PR2 · B1)

- **Scope:** `ga4_daily_geo` (country) + `ga4_daily_technology` (device/browser/os) tables, D1+PG + parity;
  deterministic upsert keys; project/date indexes; bounded cardinality; quota-aware sync; capability-gated
  empty states. Then make device/country filters real.
- **Key files:** `src/db/ga4.schema.ts` + `src/db/pg/ga4.schema.ts`, `drizzle/` + `drizzle-pg/` new migration,
  `src/server/features/ga4/services/{Ga4SyncService,ga4SyncUtils,Ga4Service}.ts`, `ga4Migration.test.ts`.
- **Accept:** parity test green; quota/partial/zero-row semantics preserved (Constitution P21/P23);
  no `SUM(users)` violations.

#### 003 — SERP contract discovery + freeze (PR5 · S0–S1)

- **Scope:** discovery report (actual code path, types, adapters, resolver, cache, trace) + frozen normalized
  `SerpSnapshot` contract following repo conventions. **No enrichment implementation in this package.**
- **Key files:** `src/server/features/serp/*`, MCP `get_serp_results` handler, `SeoCacheService`/R2 helpers.
- **Accept:** G4 satisfied: downstream UI/detectors consume normalized data only; S0 doc checked into the spec.
- **Status (2026-09-28): DONE — G4 SATISFIED.** Frozen contract: `specs/003-serp-contract-discovery/contracts/serp-snapshot.md`
  + `src/server/features/serp/types.ts` (Zod: `serpSnapshotSchema`, `canonicalSerpSnapshot`,
  `serpSnapshotIdentityKey`); fixtures `src/server/features/serp/serpSnapshot.test.ts` (full + sparse);
  boundary guards `src/server/features/serp/serpBoundaries.test.ts` (no-raw-parsing, report integrity,
  vocabulary). Discovery report: `specs/003-serp-contract-discovery/research.md` (incl. 5 doc-vs-code
  discrepancies, code-authoritative). 007/011 must consume this contract as mandatory input.

#### 004 — Striking-distance detector (PR8 · C1)

- **Scope:** deterministic detector `positions ≈11–20 + impressions floor` via existing detector registry +
  versioning; skip on insufficient impressions / incomplete coverage / failed rank (§2.2 band reconciliation).
- **Key files:** `src/server/features/intelligence/detectors/{registry.ts,types.ts}` + new detector + fixtures;
  `FindingService.ts` coverage gating.
- **Accept:** all no-trigger negatives pass; `findingKey` stable; no second scoring model (G3).

#### 005 — Reports share/PDF hardening (PR14 · D1)

- **Scope:** hash-only share tokens, single-display raw token, revoke/expiry, report events, PDF-exported event,
  public-page credential isolation, R2 logos, project client profile. **Security correction:** never persist raw
  `shareToken` on `report_schedules` (G7).
- **Key files:** `src/server/features/reports/services/{ReportService,ShareService,BrandingService,ExportService}.ts`,
  `src/serverFunctions/reports.ts`.
- **Accept:** token lifecycle tests; leak audit (no credentials/costs on public route).

#### 006 — Canonical SEO URL identity (PR3 · B2a) — G1 shipper

- **Scope:** §2.1 — extend `normalizeGa4LandingPage` → full canonical identity; single shared helper for GA4/GSC/
  Rank/SERP/Audit joins; fixture suite (trailing slash, query strings, encoding, subdomains, Arabic paths,
  cross-domain isolation). **No cross-source page detector ships before this (G1).**
- **Key files:** `src/shared/ga4.ts`, `src/shared/intelligence.ts`, `src/shared/ga4Normalize.test.ts`,
  `src/shared/intelligence.test.ts`, `ga4SyncNormalize.ts`, `AnalyticsJoinService.ts`.
- **Accept:** G1 gate recorded as passed; all consumers import the one helper (import-ban test extended).

#### 007 — SERP Top-10 enrichment (PR6 · S2–S3/S6–S8/S10/S12)

- **Scope:** Top-10-only bulk rank/backlinks enrichment; canonicalize→dedupe→bulk→merge-by-identity
  (never positional); separate SERP-snapshot vs target-metric cache freshness (R2 patterns, no MVP migration);
  async skeleton (base SERP first, enrichment never fails the panel); `0` vs `—` vs `unavailable` semantics;
  40201≠40200 classification; trace `serp_analysis`/`serp_competitive_enrichment`; expanded competitor row;
  mandatory test matrix (selection/bulk/merge/value-semantics/errors/UI/cache).
- **Accept:** no N+1 (G8); repeat enrichment = zero paid calls via cache; concurrent coalesce via singleFlight.

#### 008 — Lost-backlink opportunity (PR9 · C2a)

- **Scope:** detector over existing backlink-change inputs; provider failure ≠ loss (G9); frozen evidence.
- **Key files:** `backlinkChange.ts` (+ fixtures), `OpportunityMaterializer.ts`, backlink snapshot service.
- **Accept:** failure-input negatives; event ledger idempotency.

#### 009 — Email delivery spike (PR15 · D2a) — G6 decider

- **Scope:** time-boxed spike verifying Loops/email infra (quota, sender/template ownership, failure semantics,
  idempotency). **Output is exactly one verdict:** `EMAIL_DELIVERY_READY` or `EMAIL_DELIVERY_BLOCKED`.
- **Accept:** verdict recorded; 012 stays Draft unless READY.

#### 010 — GA4 joins, goals, GA4-backed detectors, opps depth (PR4+PR10+PR11)

- **Scope:** `ga4_project_goals` table + CRUD + analytics filtering (never sum non-additive users);
  organic join service (GA4×GSC×Rank via 006 identity, DB-first, coverage-gated, correlational language only);
  C2b conversion + C2c engagement detectors; opportunities UI filters (page/keyword/source/type/status/priority)
  - evidence detail. Needs 002 + 006 (G1, G2).
- **Accept:** absent-GA4 degradation (confidence caps, no false findings); join correctness fixtures.

#### 011 — SERP features + Dashboard intelligence UI (PR7+PR12+PR13)

- **Scope:** PAA/featured/local-pack/images/video/shopping/news/KG/sitelinks/related normalization + rendering
  (no fabrication); PAA placement rule; mobile card view (position/result/summary, metrics in expansion);
  Dashboard sections (A1) on 001 contracts; unified 11-state section model (A2) with deterministic
  service→view mapping.
- **Accept:** dashboard state matrix tests; mobile no-overflow; base SERP survives enrichment failure.

#### 012 — Scheduled reports (PR16 · D2b) — conditional on 009

- **Scope:** `report_schedules` + `report_schedule_runs`; weekly/monthly MVP; idempotent ledger
  (§2.4); existing cron infra only.
- **Accept:** cron re-entry never double-generates/sends; boundary test updated in same PR.

#### 013 — Autopilot workflows + orchestration (PR17+PR18+PR21)

- **Scope:** content-refresh, technical-SEO, monthly-review workflows (deterministic-first, frozen evidence,
  observational language, no invented uplift); SAM chat start/get/list/cancel/resume via existing adapter
  patterns + allowlist + budgets.
- **Accept:** frozen-evidence tests; workflow-output causal-verb bans; E2E start→poll→resume.

#### 014 — Competitor-gap conditional (PR19→PR20→E1d) — stays Draft

- **Scope:** input spike first (DataForSEO quality, crawl coverage, cost, entity identity, cache reuse) →
  go/no-go → detector/workflow only on pass (G5). Never blocks other packages.

---

## 4. Cross-cutting layers (fold into every package, not separate specs)

- **MCP:** thin wrappers only. New tools `get_analytics_acquisition/events/conversions` land with 010;
  SERP `includeCompetitiveMetrics: false` default lands with 007 (opt-in, paid-guard).
  Later/optional: `get_insight_detail`, `run_autopilot_workflow` with 013.
- **Global Trace:** each package extends taxonomy incrementally
  (`ga4_sync/read`, `intelligence_scan`, `opportunity_materialize`, `serp_analysis`,
  `serp_competitive_enrichment`, `report_generate/schedule`, `autopilot_run`) with secret scrubbing.
  Trace is observability, never source of truth (Constitution P42).
- **DB rules for all schema packages:** additive D1+PG migrations, parity tests, project-scoped FKs,
  `runBatch`/`executeInBatches` only, indexes for actual query patterns.

---

## 5. SpecKit execution workflow

```text
for each package 001→013 in wave order (§3 table):
  /speckit.specify  "package goal + scope + acceptance from §3"   → specs/<NNN>-<name>/spec.md
  /speckit.clarify  (only where §2 flags ambiguity: 004 band, 006 host rules, 007 ETV/Spam availability)
  /speckit.plan     → plan.md (+ research.md, data-model.md, contracts/)
  /speckit.tasks    → tasks.md (PR-sized, with wave-parallel [P] markers)
  implement → review vs Constitution §20.3 checklist → merge
014 stays Draft until its spike verdict. 012 stays Draft until 009 = READY.
```

**Wave parallelism (from source plan §19):**

- Wave 1: 001 · 002 · 003 · 004 · 005 (+ trace)
- Wave 2: 006 · 007 · 008 · 009
- Wave 3: 010(part) · 011(part) · 012(if READY) · 013(part: safe workflows)
- Wave 4–5: remainder + 014 (conditional) + 013 orchestration last (needs stable evidence contracts)

**Constitution check per package (`.specify/memory/constitution.md` §§20.3, App. A/C):**
layering (P1–P2) · parity (P3–P5) · provider set/semantics (P6–P10) · cache/cost bounds (P11–P13) ·
SERP law (P14–P17) · GSC/GA4 semantics (P21–P23) · URL identity (P24) · intelligence law (P25–P28) ·
dashboard/reports/autopilot law (P29–P36) · security (P38–P40) · trace (P41–P42) · tests (P43–P45) ·
truthfulness (P46–P47) · scope discipline (P50).

---

## 6. Definition of Done (program-level, from source plan §24)

Dashboard is intelligence overview (stored data) · GA4 geo/tech filters real · URL identity deterministic ·
organic joins reliable · detectors C1/C2a–C2c live · SERP Top-10 metrics + features bounded-cost ·
reports immutable + schedulable (no dupes, no raw tokens) · autopilot content/technical/monthly + SAM
orchestration · competitor-gap only on spike pass · MCP thin · trace coverage · parity green ·
failure≠zero everywhere · no new provider · no second engine/resolver.

---

## 7. Risks carried forward (source plan §22 + review)

1. GA4 cardinality (geo/tech explosion) → bounded dims, quota-aware sync, short backfill, checkpoints (002).
2. URL identity collisions → G1 gate + fixture suite (006).
3. SERP cost blowup → Top-10 only, bulk, target cache, singleFlight, budgets (007).
4. Partial bulk responses shifting rows → merge-by-identity, explicit unavailable (007).
5. Competitor input quality → mandatory spike, conditional ship (014).
6. Schedule duplication on 15-min cron → `(scheduleId, scheduledFor)` uniqueness + run ledger (012).
7. Autopilot overreach → frozen evidence, allowlist, bounded tools (013).
8. Wave-1 A0/B1 overlap → contract-first per §2.5 (001).

---

_Next action: run `/speckit.specify` for `001-dashboard-stored-rollups` (Wave 1, no dependencies).
Parallelizable same-wave starts: 002, 003, 004, 005._
