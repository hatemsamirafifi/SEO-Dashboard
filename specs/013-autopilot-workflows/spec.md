# Feature Specification: Autopilot Workflows + SAM Orchestration (content-refresh, technical-SEO, monthly-review, chat start/get/list/cancel/resume)

**Feature Branch**: `013-autopilot-workflows`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Wave 3–5 (per docs/speckit-implementation-plan.md §3): package 013 — Autopilot workflows + orchestration (PR17 + PR18 + PR21, Track E). Content-refresh (E1a), technical-SEO (E1b), and monthly-review (E1c) workflows, deterministic-first, reading only stored engine state (frozen evidence, observational language, no invented uplift percentages); monthly review summarizes what changed, what remains unresolved, and evidence-backed next actions from GSC/GA4/rank/opportunities/insights/audit/backlink evidence. SAM chat orchestration (E2): start, get, list, cancel, and resume autopilot runs through existing SAM tool adapter patterns with an explicit workflow allowlist and existing budgets — no unconstrained autonomous workflow selection, no run-starters performing render-time paid provider reads (G10). Extends the existing autopilot runtime (runs/attempts/steps, attempt source-version pins, budgets, synthesis firewall) and the existing SAM chat agent/MCP tool patterns — no new queue engine, no second intelligence engine (Constitution P25, P34–P37, P50). MCP `run_autopilot_workflow` deferred-later per plan §4."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Content-refresh workflow surfaces pages worth refreshing from stored evidence (Priority: P1)

A project owner wants a repeatable answer to "which existing content should I refresh and why?" They start a content-refresh autopilot run. The workflow is deterministic-first: it collects only stored engine state (opportunities, insights — the frozen evidence the Intelligence Engine already produced), correlates candidates by stored priority/impact/confidence, and synthesizes recommendations with observational language ("decreased during the same period", "consistent with") — never causal claims and never invented uplift percentages. The run, its attempts, and its step evidence appear in the existing autopilot run surfaces with the same frozen-evidence and version-pin guarantees as the existing workflows (growth_plan, quick_wins, traffic_drop).

**Why this priority**: PR17 is the first wave-3 slice of this package; it proves the new-workflow pattern (register, collect stored state, correlate, synthesize behind the existing synthesis firewall) end-to-end and is fully shippable on its own before technical-SEO lands.

**Independent Test**: Can be fully tested by starting a content-refresh run against seeded stored opportunities/insights (no provider, no LLM required for collect/correlate steps) and asserting registered workflow definition shape, frozen step evidence, version-pin behavior, observational-language enforcement on synthesis output, and standard run-lifecycle states.

**Acceptance Scenarios**:

1. **Given** a project with stored opportunities (incl. content-decay/ranking-drop types) and unresolved insights, **When** a content-refresh run starts and executes, **Then** the collect step reads only stored engine output, the correlate step ranks candidates deterministically from stored fields, and each step's evidence is frozen, JSON-serializable, and version-pinned to the attempt.
2. **Given** a completed content-refresh run, **When** its synthesis output is inspected, **Then** every recommendation cites metrics and periods from the frozen evidence, uses observational phrasing, keeps impact and confidence separate, and contains no causal verbs and no uplift percentages without an evidence basis.
3. **Given** the existing synthesis firewall, **When** the synthesize step executes, **Then** it may only consume frozen step evidence from the single attempt whose source-version hash matches the attempt pin — cross-attempt or mixed-version synthesis fails the run honestly.
4. **Given** the workflow registry, **When** the content-refresh definition registers, **Then** it does so through the existing registration seam with the existing step/budget contracts (dense 0-based sequence, side-effect steps require idempotency keys, budgets bounded by the existing tool-call and wall-clock caps) — no parallel executor is introduced.

---

### User Story 2 - Technical-SEO workflow plans fixes from audit/opportunity/insight evidence (Priority: P2)

An SEO practitioner wants a prioritized technical fix plan for the project. They start a technical-SEO autopilot run. The workflow consumes audit evidence plus stored opportunities and insights — the technical facts the engine already detected (e.g., technical issues on important pages) — and produces a plan that clearly separates what happened (evidence) from what OpenSEO recommends (recommendation). The workflow makes no live provider calls from any step: unless an explicitly approved, already-existing tool path is the sanctioned source for a needed input, the workflow reads stored state only; a provider outage or never-run audit yields an explicit "insufficient coverage / not yet run" outcome — never a fabricated empty plan.

**Why this priority**: PR17's second half; depends on US1's workflow pattern but needs audit-evidence collection, which is independent of monthly-review's cross-source evidence and can ship as soon as the pattern exists.

**Independent Test**: Can be fully tested by seeding audit results and opportunities, starting a technical-SEO run, and asserting the collected evidence matches stored audit/opportunity state, no provider client is invoked by any workflow step, failure/absence of audit data produces the explicit no-trigger state, and output separates facts from recommendations.

**Acceptance Scenarios**:

1. **Given** a project with stored audit issues and technical opportunities, **When** a technical-SEO run executes, **Then** its plan ranks technical work from stored severity/priority and cites the underlying evidence per item.
2. **Given** a project where the site audit has never run or is stale, **When** a technical-SEO run executes, **Then** the run completes (or is skipped with reason) reporting insufficient/absent audit coverage explicitly — it never presents absence of audit data as "no technical issues".
3. **Given** the workflow step set, **When** any step runs, **Then** no step performs a live provider call; all inputs are stored evidence, and any side-effect step (if one exists) carries a domain-level idempotency key.
4. **Given** a completed technical-SEO run, **When** its output is rendered, **Then** facts ("what happened") and recommendations ("what OpenSEO suggests doing") are distinguishable throughout (P27).

---

### User Story 3 - Monthly-review workflow summarizes the month honestly from frozen evidence (Priority: P3)

At month end, the owner wants a defensible summary of the month. They start a monthly-review run: the workflow collects frozen evidence already stored from GSC, GA4, rank tracking, opportunities, insights, audit, and backlinks, and synthesizes three things — what changed this month versus prior period, what remains unresolved (open opportunities/insights), and evidence-backed next actions. Claims stay observational: movements are "observed alongside" / "coincided with", single-source claims are marked provisional, and non-additive metrics are never summed across periods or sources (GA4 distinct users never become false totals). Where a source has no data, the review says so rather than rendering zeros.

**Why this priority**: PR18 (wave 4) needs the widest evidence set, so it lands after the two PR17 workflows prove the pattern and after upstream evidence contracts (006 URL identity, 010 joins/goals, 011 sections) are stable; it is also the workflow monthly cadence would eventually schedule, but manual start is the MVP.

**Independent Test**: Can be fully tested by seeding stored period data for two consecutive months plus open opportunities/insights, starting a monthly-review run, and asserting the synthesized summary reports per-source changes with correct window comparisons, flags single-source claims as provisional, preserves zero/missing/unavailable distinctions, and lists next actions only from stored evidence.

**Acceptance Scenarios**:

1. **Given** stored month-over-month evidence across GSC, GA4, rank, opportunities, insights, audit, and backlinks, **When** a monthly-review run executes, **Then** the summary states what changed per source with periods, what remains unresolved, and next actions backed by cited stored evidence.
2. **Given** a metric available from only one source, **When** the summary references it, **Then** it is marked provisional/single-source, never presented as corroborated.
3. **Given** a source that is unconnected or has no stored data for the period, **When** the summary renders, **Then** that source appears as no-data/unavailable, never as zero values (P8/P9/P21).
4. **Given** the synthesis step, **When** it builds the summary, **Then** non-additive metrics are computed from appropriate aggregates rather than summed, and no claim uses causal language or invented uplift percentages.
5. **Given** the run completes, **When** viewed later, **Then** its step evidence remains frozen — the review does not recalculate from live data on later views.

---

### User Story 4 - SAM chat starts and manages autopilot runs through an allowlisted tool surface (Priority: P4)

A user conversing with SAM says "run the content-refresh workflow" or "what happened to my last autopilot run?". SAM exposes five autopilot tools — start, get, list, cancel, resume — built through the existing SAM/MCP tool adapter patterns and delegating to the same service methods the autopilot UI already uses. Start/resume accept only workflows on the explicit allowlist (the three existing workflows plus the new ones registered by this feature, as product-approved); an unrecognized workflow name is rejected with a clear error, never silently resolved. Budgets are the existing autopilot budgets (tool-call cap, wall-clock, attempts) — orchestration adds no new unbounded execution. Run state and step evidence surfaced to the conversation are reads of the durable run record (observability), and the durable run ledger remains the source of truth. Starting a run from chat never triggers render-time paid provider reads: workflow steps consume stored evidence only (G10).

**Why this priority**: PR21 lands last (wave 5) — the plan requires stable workflow definitions and evidence contracts before orchestration is exposed to the model; it is the package's integration payoff and depends on US1–US3.

**Independent Test**: Can be fully tested with the model layer stubbed: the five adapted tools call the same service methods as the UI server functions, allowlist enforcement rejects non-allowlisted workflow types, cross-project access is denied, and an E2E-style start → poll → cancel → resume lifecycle round-trips through the durable run record.

**Acceptance Scenarios**:

1. **Given** a user chatting in a project context, **When** SAM calls the start tool with an allowlisted workflow type, **Then** a run starts via the same service entry point as the UI, project-scoped, with trigger provenance recorded as chat-initiated.
2. **Given** a model attempt to start a workflow not on the allowlist (including competitor-gap or arbitrary strings), **When** the tool executes, **Then** it fails closed with an explicit not-allowed error and no run is created.
3. **Given** an active run, **When** the user asks SAM for status, **Then** the get/list tools return the durable run state, attempts, and step checklist — identical data to the UI run view.
4. **Given** a running or paused run, **When** SAM calls cancel or resume, **Then** the run transitions exactly as the UI-driven operations do (same service methods, same authorization, same trace/audit coverage).
5. **Given** any chat-initiated run, **When** its steps execute, **Then** no step performs a render-time paid provider call; all paid or provider-touching behavior, if any, remains confined to explicitly approved bounded tool paths with existing budget guards (G10).
6. **Given** a chat request naming a run from a different project, **When** the tool executes, **Then** access is denied — no cross-project leakage (P39).

---

### Edge Cases

- **Source change mid-run**: a detector scan or sync advances source versions while a run's attempt is in flight — the attempt is invalidated by the existing version-pin mechanism, the run retries within the existing attempt cap, and synthesis never mixes evidence across attempts (existing firewall; extended to the new workflows).
- **Empty engine state**: no opportunities/insights/audit data exist — workflows complete with honest "nothing to act on / no coverage" outcomes, never fabricating findings; empty is not failure (P21 semantics).
- **Provider outage during collection**: since workflows read stored state only, an outage cannot corrupt a run; if an explicitly approved bounded tool path is temporarily unavailable, the affected step records unavailable explicitly — never zero/no-result (P8/P9, G9).
- **Duplicate concurrent starts**: a user (and SAM, or two sessions) starts the same workflow twice — the existing single-active-run-per-workflow conflict handling applies; the second start fails honestly with a clear conflict error.
- **Budget exhaustion mid-run**: tool-call or wall-clock caps hit — the run fails with the recorded exhaustion state; resume creates a fresh attempt bounded by the same caps (idempotency prevents duplicated side effects).
- **Chat-requested workflow with stale evidence**: evidence sources pinned at attempt start; the run reports the evidence versions it used so stale-ness is visible, not hidden (P46–P47).
- **Cancel racing step completion**: cancel during a final step — existing run lifecycle resolves to one terminal state; no half-cancelled run renders as active.
- **Unregistered workflow type at runtime** (definition registration failure): start fails closed with an explicit error — never a null run or silent fallback to another workflow.
- **Resume after source invalidation**: resumed attempt re-collects evidence under the new pin; prior attempt's evidence stays stored but cannot feed synthesis of the resumed attempt (mixed-version synthesis remains structurally impossible).

## Requirements *(mandatory)*

### Functional Requirements

**Content-refresh workflow (US1 — PR17)**

- **FR-001**: The system MUST provide a content-refresh autopilot workflow registered through the existing workflow-definition seam, whose steps read only stored engine output (opportunities, insights) and freeze per-step evidence with source-version pins identical in guarantee to the existing workflows.
- **FR-002**: Content-refresh synthesis MUST produce observational recommendations — metrics and periods cited from frozen evidence, impact and confidence kept separate, no causal verbs, and no uplift percentages lacking an evidence basis (P26, P46).
- **FR-003**: Content-refresh synthesis MUST only consume frozen step evidence from a single attempt whose source-version hash matches the attempt pin (existing synthesis firewall extended to the new definitions).

**Technical-SEO workflow (US2 — PR17)**

- **FR-004**: The system MUST provide a technical-SEO autopilot workflow that consumes stored audit, opportunity, and insight evidence and separates observed facts from recommendations in its output (P27).
- **FR-005**: No workflow step MUST perform a live provider call; absent or stale audit coverage MUST produce an explicit insufficient-coverage outcome, never an empty plan presented as "no issues" (P8/P9, P28).
- **FR-006**: Any side-effecting step in any new workflow MUST carry a domain-level idempotency key, per the existing step contract.

**Monthly-review workflow (US3 — PR18)**

- **FR-007**: The system MUST provide a monthly-review autopilot workflow that collects frozen, already-stored evidence from GSC, GA4, rank tracking, opportunities, insights, audit, and backlinks and synthesizes: what changed versus the prior period, what remains unresolved, and evidence-backed next actions.
- **FR-008**: Monthly-review synthesis MUST mark single-source claims as provisional, preserve zero/missing/unavailable distinctions per source, and never sum non-additive metrics across periods or sources (P9, P23, P46).
- **FR-009**: A completed monthly-review run MUST remain frozen evidence — later views never recalculate from live data (P31-style snapshot semantics for run output).

**SAM chat orchestration (US4 — PR21)**

- **FR-010**: The system MUST expose autopilot start, get, list, cancel, and resume to SAM chat through the existing tool adapter patterns, delegating to the same AutopilotService methods the UI server functions use — no parallel orchestration implementation (P1/P2).
- **FR-011**: Start and resume MUST enforce an explicit workflow allowlist; non-allowlisted workflow types MUST fail closed with an explicit error and no run created. The allowlist is exactly the registered product-approved workflows (existing three plus US1–US3 additions); competitor-gap and arbitrary types are excluded.
- **FR-012**: Chat-initiated runs MUST operate under the existing autopilot budgets (tool-call cap, wall-clock limit, attempt cap, source-changed invalidation cap) with no budget relaxation added by orchestration.
- **FR-013**: The get/list tools MUST surface the durable run record's state, attempts, and frozen step checklist; trace remains observability only — the run/attempt/step ledger stays authoritative (P42).
- **FR-014**: All five tools MUST enforce project-context authorization identical to the UI server functions; cross-project run access MUST be denied (P39).
- **FR-015**: No chat-initiated workflow step MUST perform a render-time paid provider read; workflows consume stored evidence only (G10). Starting a run from chat MUST record chat provenance (trigger) in the run record.

**Cross-cutting**

- **FR-016**: All new workflows MUST register through the existing registration seam and reuse the existing step executor, budget enforcement, attempt/pin machinery, and run lifecycle — no second workflow engine, queue, or scheduler (P2, P35, P37).
- **FR-017**: Every major operation (workflow start, cancel, resume, orchestration tool invocation, step failure) MUST emit trace-consistent observability within the existing trace taxonomy/extension pattern, with no secrets or credentials in trace output (P38, P41).
- **FR-018**: The feature MUST extend the existing test suites for its invariants: frozen-evidence/version-pin tests, workflow-output causal-verb and uplift bans, allowlist enforcement tests, budget-bound tests, and an E2E start → poll → cancel/resume lifecycle test (P43–P45).
- **FR-019**: The spec MUST record its wave dependency: US1/US2 (safe workflows) may start in wave 3; US3 (monthly review) requires stable evidence contracts (006 URL identity, 010 joins/goals, 011 sections) before implementation; US4 (SAM orchestration) lands last, after US1–US3 definitions and evidence contracts are stable. MCP `run_autopilot_workflow` exposure stays deferred-later per plan §4 (this package ships SAM-chat orchestration only).

### Key Entities

- **Autopilot Workflow Definition** (existing entity, extended): a registered step list (collect/correlate/transform/synthesize/side_effect) with workflow identity, prompts, and deterministic helpers; extended with three new product-approved types (content-refresh, technical-SEO, monthly-review) that read stored evidence only.
- **Autopilot Run** (existing entity): the durable, project-scoped run record with workflow type, trigger provenance (manual, chat), status lifecycle (pending → running → completed/failed/cancelled), and budget accounting — unchanged shape, new workflow types and chat trigger values.
- **Autopilot Attempt** (existing entity): an execution try pinned to frozen source versions, invalidated and retried when versions change, capped by the attempt limit — unchanged shape, exercised by the new workflows.
- **Autopilot Step Evidence** (existing entity): per-step frozen, JSON-serializable evidence with hash and effective source versions; the only input synthesis may consume (firewall).
- **Workflow Allowlist** (new, configuration-scale concept): the explicit set of workflow types start/resume accept — defined once, shared by UI validation and SAM tools, never inferred from registry state alone (registry membership is necessary but allowlist membership is the product decision).
- **SAM Autopilot Tool Surface** (new surface over existing entities): the five adapted tools (start/get/list/cancel/resume) delegating to AutopilotService; reads return the same run views the UI renders.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of workflow-output fixtures under test contain zero causal-verb sentences and zero unsupported uplift percentages — enforced by a mechanical output check (causal-verb/uplift ban) across every new workflow's synthesized evidence (plan acceptance: "workflow-output causal-verb bans").
- **SC-002**: 100% of frozen-evidence test cases pass: every step's evidence is version-pinned, cross-attempt synthesis attempts fail closed, and no completed run's evidence changes on later reads (plan acceptance: "frozen-evidence tests").
- **SC-003**: The full lifecycle — start (chat and UI) → poll → cancel → resume → terminal state — completes correctly in 100% of E2E test executions, with each transition visible in the durable run record (plan acceptance: "E2E start→poll→resume").
- **SC-004**: 100% of non-allowlisted workflow-type start attempts (across fixture types: unknown strings, unregistered types, excluded types) fail closed with zero runs created.
- **SC-005**: Zero live provider calls occur across all workflow-step test executions — verifiable by provider-client instrumentation returning zero invocations from any new workflow step.
- **SC-006**: Zero/missing/unavailable distinctions survive end-to-end: in 100% of no-data and partial-coverage fixtures, outputs render explicit no-data/unavailable/provisional states, never zeros (P8/P9/P21 audit fixture coverage).
- **SC-007**: Every chat tool invocation completes within the existing budget envelopes — tool-call caps and wall-clock limits hold in 100% of budget-exhaustion fixtures, and resume after exhaustion creates exactly one new bounded attempt.
- **SC-008**: A monthly-review run over a 3-month simulated fixture span reports per-source month-over-month changes with correct windows in 100% of cases, with non-additive metrics never summed across periods.

## Assumptions

- **E0 runtime is the base**: the existing runs/attempts/steps machinery, budgets, version pins, synthesis firewall, single-active-run conflict handling, and orphan reconciliation (E0) remain as-is; this package extends definitions and the orchestration surface, it does not modify the executor's contracts (P2/P35).
- **Deterministic-first means stored-evidence-only for steps**: synthesize steps may use the existing bounded LLM tool-call allowance (existing workflows already declare `toolCalls: 1`); "deterministic-first" requires collect/correlate/transform to be pure stored reads, not that the feature avoids the existing synthesis allowance.
- **Wave dependency is a gate, not a blocker for spec work**: US1/US2 implementation may begin in wave 3; US3 waits for stable evidence contracts from 006/010/011; US4 waits for US1–US3. FR-019 records the check.
- **SAM-only orchestration in this package**: MCP-server exposure of a run-starting tool (`run_autopilot_workflow`) stays deferred-later per plan §4; the existing MCP `get_autopilot_run` read tool continues to work unchanged.
- **Manual start is the MVP for all three workflows**: scheduled/cadenced autopilot runs (e.g., monthly-review on a cron) are out of scope; scheduling machinery belongs to the existing cron infrastructure and a future package decision.
- **Existing three workflows are untouched**: growth_plan, quick_wins, traffic_drop keep their definitions; the allowlist includes them alongside the new types.
- **Chat authorization equals UI authorization**: SAM tools reuse the project-context middleware/adapter patterns; no new auth model, no relaxed scopes (P39).
- **No new schema expected** (source plan §10: "E workflow definitions — no new schema required"): runs/attempts/steps tables absorb the new workflow types; if implementation discovery proves an unavoidable storage need, it surfaces per P49 rather than assuming it here.
- **Trace extension follows the existing taxonomy increment pattern** (plan §4 `autopilot_run`): the observability vocabulary grows additively; trace never becomes authoritative (P42).
- **Competitor-gap workflow (E1d) is explicitly out of scope**: it stays gated behind its input spike (G5/P36) and is not part of this package even though it would eventually follow the same workflow pattern.