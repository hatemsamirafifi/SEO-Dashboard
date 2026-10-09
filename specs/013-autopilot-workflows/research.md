# Research: Autopilot Workflows + SAM Orchestration (013)

**Phase 0 output — resolves plan.md open decisions R1–R7.** Each decision cites the repo
evidence it is grounded in (Constitution P48: live repository contracts are authoritative).

---

## R1 — Allowlist mechanics: one shared const, enforced at three layers

**Decision**: `AUTOPILOT_WORKFLOW_TYPES` in `src/shared/autopilot.ts` (extended to six entries:
`growth_plan`, `quick_wins`, `traffic_drop`, `content_refresh`, `technical_seo`,
`monthly_review`) **is** the allowlist. It is enforced at:

1. **Trust boundary**: `startAutopilotRunSchema` in `src/types/schemas/autopilot.ts` changes
   `workflowType: z.string().min(1).max(120)` → `workflowType: z.enum(AUTOPILOT_WORKFLOW_TYPES)`
   (with `trigger` kept as a bounded free string ≤ 40 — chat passes `sam_chat`).
2. **SAM tool schemas**: the five tool input schemas use the same enum — the model can never
   submit a non-allowlisted name (rejected by Zod before the handler runs, surfacing as the
   existing curated `TOOL_INPUT_INVALID` tool-error feedback per `samToolInputErrors.test.ts`
   precedent).
3. **Service registry**: `AutopilotService.startAutopilotRun` keeps its existing
   `getAutopilotWorkflow` fail-closed check (defense in depth — an unregistered type never
   creates a run row).

**Rationale**: the const is already the single identity source consumed by the shared
labels/descriptions records, the SAM tab picker (`SamAutopilotTab.tsx` iterates
`AUTOPILOT_WORKFLOW_TYPES`), and `isAutopilotWorkflowType`. Making the Zod enum reference it
means adding a workflow type is a one-file edit + registration, and every layer (UI picker,
schemas, SAM tools, service) agrees by construction. Registry membership and allowlist
membership become the same product decision, per spec FR-011 ("registry membership is
necessary but allowlist membership is the product decision" — implemented as: the const is
edited by the product-level PRs, and nothing can be started without both const membership and
registration).

**Alternatives considered**:
- *Separate allowlist config/array decoupled from the type const* — rejected: two lists that
  must agree is drift surface (a workflow registered but not startable, or startable but
  unregistered); the spec's allowlist semantics are fully expressed by const + registry.
- *Runtime filtering of registry entries* (e.g. a `startable` flag on defs) — rejected:
  extends `AutopilotWorkflowDef` for a distinction with zero current use; the six MVP types are
  all startable.

---

## R2 — Synthesis mechanics: deterministic builders + serializer, toolCalls accounting unchanged

**Decision**: all three new workflows' synthesize steps are **deterministic pure functions**
that build recommendations/evidence objects and pass them through the existing
`serializeRecommendations` + `assertObservationalSafe` path, recording `toolCalls: 1` and
`promptVersion: 1` exactly like the three existing synthesize steps (which also record
`toolCalls: 1` as accounting for their synthesis allowance — `autopilotWorkflows.ts:110,165,213`).

**Rationale**: the existing workflows synthesize via pure builders
(`growthRecommendations`, `trafficRecommendations`) — the runtime has **no LLM invocation path
today** (`WORKFLOW_PROMPTS` is a frozen prompt-contract record asserted in tests, not consumed
by any executor code; grep confirms consumption only in `autopilotWorkflows.ts` imports and
tests). The MVP definition of "deterministic-first" is therefore: collect/correlate/synthesize
are all stored-evidence pure reads; the `toolCalls: 1` accounting preserves the budget ledger
semantics if synthesis later adopts an LLM path (a future, explicitly-decided change — out of
scope here). The serializer's causal-verb ban (`assertObservationalSafe` +
`BANNED_CAUSAL` in `autopilotSerializer.ts`) and the evidence-type discipline
(`observational` default; only `provider_confirmed`/`manual_user_assertion` unlock causal
phrasing) extend to the new outputs for free — new test cases only need to exercise them
(SC-001).

**Uplift ban**: beyond causal verbs, the serializer schema already requires a `quantified`
expected-impact to carry a `basis` string (min 1 char). New builders will never emit
`quantified` impacts (no evidence basis exists in stored data) — they emit `qualitative`
impacts only; a test asserts no new output contains an uplift percentage pattern
(`/\d+\s*%/` over recommendation text) matching SC-001's "zero unsupported uplift
percentages".

**Alternatives considered**:
- *LLM-in-the-loop synthesis via SAM's provider adapters* — rejected: no executor path exists,
  provider resolution is unconfigured in most environments, P34 forbids the workflow becoming
  an inventor of facts, and the existing pattern is pure builders; adding an LLM seam is a
  product decision with its own budget semantics (deferred, not scoped).
- *Skipping `toolCalls` accounting for deterministic synthesis* — rejected: it would change
  the budget ledger's meaning and the existing `stepExecutorBudgets.test.ts` invariants.

---

## R3 — Technical-SEO evidence: latest stored audit + issues, honest coverage semantics

**Decision**: the technical-SEO workflow's collect step reads:

1. `AuditRepository.getLatestAuditForProject(projectId)` — the latest audit row
   (status, pagesCrawled, completedAt) or `null`;
2. `AuditRepository.getIssuesForAudit(auditId)` — stored issues (severity, category/type,
   count) when an audit exists;
3. `OpportunityRepository.listActiveByProject` + `InsightRepository.listUnresolvedByProject` —
   the same engine-state reads the existing workflows use (`collectEngineState` in
   `autopilotWorkflows.ts` is exported and reused, with its priority filter).

**Coverage semantics (P28/G9)**: collect produces an explicit `auditCoverage` field in frozen
evidence with a deterministic state machine:
- no audit row → `{ state: "never_run" }`
- latest audit status is not a terminal success state (e.g. running/failed) →
  `{ state: "stale_or_failed", auditStatus }`
- terminal audit with `pagesCrawled = 0` → `{ state: "empty_crawl" }`
- terminal audit with issues → `{ state: "ready" }` + issues summary

Synthesis maps non-`ready` states to an explicit insufficient-coverage recommendation block
("audit coverage missing/stale — run a site audit first") and **never** renders an empty plan
as "no technical issues". Correlate ranks issues by the audit severity order
(`critical > warning > info` — the `auditIssues` schema vocabulary, matching the
dashboard's severityRank in `DashboardService.getAuditSummary`), then
stored opportunity priority/impact/confidence, capped at 10 like existing workflows.

**Rationale**: `getLatestAuditForProject` + `getIssuesForAudit` are the exact stored reads the
dashboard's technical card uses (`DashboardService.ts:293`), so the workflow consumes the same
evidence surface as the product UI — no parallel read path. Audit data is stored crawl output
(Lighthouse included), never a live provider call (P28, G10).

**Alternatives considered**:
- *Reading `collectOverviewParts`' technical envelope* — rejected: it collapses to a
  pagesCrawled/topIssues summary designed for report sections; the workflow needs per-issue
  severity ranking, which the repository read provides directly.
- *Triggering a new audit from the workflow* — rejected: violates stored-evidence-only steps
  (spec FR-005, P28) and would make a workflow a mutation orchestrator; starting audits stays a
  user action (or a SAM `run_site_audit` tool call the user can request — the workflow itself
  never does).

---

## R4 — Monthly-review evidence: calendar-month windows, collectors reused, aggregates respected

**Decision**: the monthly-review collect step derives two windows deterministically:
`month = [first day of previous complete UTC calendar month, last day of that month]` and
`prior = [the calendar month before that]` (UTC — consistent with cron/report conventions;
late-started runs still review the previous *complete* month, never a partial current month).
It then calls, for **both** windows in parallel:

- `collectSearchVisibility(projectId, from, to)` — GSC clicks/impressions/CTR/position totals
- `collectTrafficAndConversions(projectId, organizationId, from, to)` — GA4 sessions/engaged
  sessions/pageviews/key events + transactions
- `collectOverviewParts(projectId, domain)` — rank summary, audit status, backlink referring
  domains (current-state snapshot, not windowed — these are latest-state sources)
- `collectInsights(projectId)` + `collectOpportunities(projectId)` — unresolved/open engine
  state

Every collected value keeps its collector's status envelope verbatim (READY with data, or
`unavailable("not_connected" | "no_coverage" | "provider_failed" | "no_data")`).

**What-changed computation (correlate step)**: a pure function compares month vs prior per
metric **within the same source and the same envelope semantics**: a change row exists only
when **both** windows are READY for that metric; any unavailable window yields a
`{ source, status: "unavailable", reason }` row instead — never a zero-delta
(P8/P9). Movement deltas are computed only on additive metrics (clicks, impressions,
sessions, pageviews, key events, transactions); **non-additive metrics (CTR, position,
engagement) are compared side-by-side as month/prior values, never differenced into a
misleading "improvement" number** (P23 — ratios recompute from totals, which the collectors
already do per-grain).

**Next-actions and unresolved (synthesize)**: unresolved = open Critical/High opportunities +
unresolved insights (capped, ranked like existing workflows); next-actions are recommendations
built only from those stored rows, each citing its source rows. Single-source findings (a
metric corroborated by no second source) are tagged `single_source` → provisional in output,
mirroring the existing `corroborated | single_source` agreement vocabulary in
`autopilotWorkflowContent.ts`.

**Rationale**: `reportSections.ts` collectors are the product's established honest-evidence
surface — they already implement not_connected/no_coverage/provider_failed/no_data with
per-metric nullability, and are exactly what report snapshots freeze (P31-analog for run
evidence). Reusing them means zero new provider semantics and automatic P21/P8/P9 compliance;
the workflow adds only the two-window comparison and the synthesis.

**Alternatives considered**:
- *Custom repository reads per source* — rejected: duplicates the collectors' coverage/absence
  logic (drift surface; P2).
- *Rolling 30-day windows* — rejected: "monthly review" is a calendar concept; reports and
  schedules (012) use calendar derivations; late runs must not silently shift the window.
- *Differencing CTR/position* — rejected: non-additive deltas fabricate precision (P23).

---

## R5 — SAM tool placement: MCP definitions adapted into SAM only; fresh-read for run polls

**Decision**: five new tool definitions live in `src/server/mcp/tools/autopilot-run-tools.ts`
following the `report-autopilot-tools.ts` shape (`withMcpProjectAuth` + `mcpResponse` +
output schemas; `start`/`resume` annotations `readOnlyHint: false`, get/list
`readOnlyHint: true`):

| Tool | Delegates to (AutopilotService) | Notes |
| --- | --- | --- |
| `start_autopilot_run` | `startAutopilotRun({ ..., trigger: "sam_chat" })` | input: `workflowType` enum; `projectId` injected by adapter |
| `get_autopilot_run` | `getAutopilotRun` | run + attempts + step table (mirrors existing MCP tool's text shape) |
| `list_autopilot_runs` | `listAutopilotRuns` | bounded rows, status + workflow type columns |
| `cancel_autopilot_run` | `cancelAutopilotRun` | terminal-state idempotency inherited from service |
| `resume_autopilot_run` | `resumeAutopilotRun` | only running/cancelled resumes (service rule) |

`buildSamMcpTools` (`samChatTools.ts`) adapts all five via the existing `adapt()` helper —
project injection, tracker dedup, guarded execute, per-turn recovery all inherited.
`get_autopilot_run` and `list_autopilot_runs` are added to `FRESH_READ_TOOLS` **by name check
in `autopilot-run-tools.ts`'s own exports** — concretely: `samChatTools.ts` adds the two names
to the existing `FRESH_READ_TOOLS` set (a cached "running" snapshot would repeat stale state
until DO eviction — the exact failure mode the set exists for).

**Public MCP route**: **not registered** — `src/server/mcp/server.ts` gains no entries. The
source plan defers run-starters from the public MCP surface (§22 Later list: "
`run_autopilot_workflow` with 013 — Later/optional"); SAM gets them first because the session
DO already carries the user identity the handlers need.

**Trigger provenance**: chat starts pass `trigger: "sam_chat"` (≤ 40 chars, fits the existing
`trigger` text column written by `AutopilotService.ts:120`); UI starts keep `"manual"`. No
schema change; run rows are indistinguishable in shape, only in trigger value — exactly the
provenance spec FR-015 requires.

**Alternatives considered**:
- *AI-SDK-native tools defined inline in `samChatTools.ts`* (like `map_links`/`read_pages`) —
  rejected: those exist because they are SAM-only conveniences; autopilot operations are
  project-scoped product operations that belong in the shared MCP-definition shape so the
  eventual public registration (if ever approved) reuses the exact same definitions.
- *Registering on the public MCP route now* — rejected: plan §4 marks it Later/optional;
  public run-starters need their own product review (external clients could burn budgets).
- *Cached run polls for cheaper repeat calls* — rejected: contradicts the live-polling UI
  contract and the FRESH_READ precedent.

---

## R6 — Attempt-pin coverage: pins already cover every new collect surface

**Decision**: **no new pin work**. The attempt pin is assembled by
`assembleDetectionSourceState` from five source versions — GSC, GA4, rank, audit, backlinks
(`SourceTokens.ts:254`), and collect steps dual-gate against it
(`runCollectStep` → `invalidateAttempt` on hash mismatch, `stepExecutor.ts`). The new
workflows' evidence sources are:

- content-refresh: opportunities + insights → intelligence engine outputs (detector/scan runs
  advance versions — covered by the pin machinery the existing workflows already rely on);
- technical-SEO: audit rows + issues → the `audit` source version (an audit completing/being
  replaced advances it);
- monthly-review: GSC/GA4/audit/backlinks collectors → gsc/ga4/audit/backlinks versions; rank
  summaries → rank version; opportunities/insights → engine versions.

Every source a new workflow can read is already a pin input, so mid-run source changes
invalidate the attempt and synthesis stays single-universe (firewall) — the E0 semantics
extend unchanged. One nuance recorded in contracts: **opportunity status edits (user
marking items in_progress/completed) do not advance source versions by design** (they are
lifecycle state, not detection evidence — same behavior the existing workflows have); the
frozen evidence records `collectedAt` making staleness visible (P46).

**Alternatives considered**: adding new source-version inputs (e.g. an "opportunities version")
— rejected: changes intelligence-engine contracts for a distinction the existing three
workflows already live with; P50.

---

## R7 — UI surface: picker extends by data; evidence renderers extend minimally

**Decision**: `SamAutopilotTab.tsx` requires no structural change — it iterates
`AUTOPILOT_WORKFLOW_TYPES` and renders labels/descriptions from the shared records, so the
three new types appear once added. The only client work is in
`autopilotEvidence.ts`: the shared step-evidence renderers currently understand the existing
output shapes (`recommendations`, correlation tables). New renderer entries:

- content-refresh: recommendation cards (existing shape — reuses `recommendationCards`);
- technical-SEO: facts block (issue counts by severity + audit coverage state) + a
  recommendation list — facts vs recommendations visually separated (P27);
- monthly-review: three sections (changed / unresolved / next actions) with per-source status
  chips (READY/unavailable) and `single_source` provisional tags.

**Rationale**: the tab is picker+poll+cards by design (final-plan A17 notes); new types are
data, not code, for the picker; evidence rendering is the one genuinely new surface and it
extends the existing evidence module where its tests already live
(`autopilotEvidence.test.ts`).

**Alternatives considered**: a dedicated per-workflow page/route — rejected: scope discipline
(P50); the SAM tab is the product surface for autopilot runs.

---

## Summary of decisions feeding Phase 1

| ID | Decision | Contract artifact |
| --- | --- | --- |
| R1 | Six-entry `AUTOPILOT_WORKFLOW_TYPES` const = the allowlist; Zod enum at trust boundary; SAM schemas same enum; service registry fail-closed | workflow-definitions.md §1 |
| R2 | Deterministic synthesis via existing serializer; `toolCalls: 1` accounting; qualitative impacts only; uplift-pattern test ban | workflow-definitions.md §4 |
| R3 | Technical-SEO reads latest audit + issues + engine state; explicit `auditCoverage` state machine (`never_run`/`stale_or_failed`/`empty_crawl`/`ready`) | workflow-definitions.md §3 |
| R4 | Monthly review = prior complete UTC month vs its predecessor; collectors reused with status envelopes verbatim; additive-only deltas; CTR/position side-by-side | workflow-definitions.md §3 |
| R5 | Five tools in `autopilot-run-tools.ts` (MCP shape), adapted into SAM only; get/list fresh-read; `trigger: "sam_chat"`; no public route registration | sam-autopilot-tools.md |
| R6 | No new pin inputs — all new evidence sources are already pin-covered | workflow-definitions.md §5 |
| R7 | Picker extends by data; `autopilotEvidence.ts` gains three renderers; no new routes | sam-autopilot-tools.md §4 |

All seven decisions resolved with repo evidence; no NEEDS CLARIFICATION remains.