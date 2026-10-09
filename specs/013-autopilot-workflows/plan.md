# Implementation Plan: Autopilot Workflows + SAM Orchestration (013)

**Branch**: `013-autopilot-workflows` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-autopilot-workflows/spec.md`

## Summary

Deliver package 013 (PR17 + PR18 + PR21 · Track E) in four slices that extend — never fork — the
existing autopilot runtime and SAM tool surface:

1. **Content-refresh workflow (E1a, PR17)** — a fourth registered workflow following the exact
   established three-step shape (collect stored engine state → correlate deterministically →
   synthesize through the serializer firewall with observational-language enforcement), reading
   only stored opportunities + insights.
2. **Technical-SEO workflow (E1b, PR17)** — same pattern, collecting stored audit evidence
   (`AuditRepository.getLatestAuditForProject` / `getIssuesForAudit`) plus stored
   opportunities/insights; absent/stale audit → explicit insufficient-coverage outcome, never an
   empty plan presented as "no issues" (P8/P9/P28).
3. **Monthly-review workflow (E1c, PR18)** — collects frozen evidence for one calendar month and
   its predecessor by reusing the reports feature's honest-evidence collectors
   (`collectSearchVisibility`, `collectTrafficAndConversions`, `collectOverviewParts`,
   `collectInsights`, `collectOpportunities` in `src/server/features/reports/services/reportSections.ts`),
   which already return READY / `not_connected` / `no_coverage` / `provider_failed` / `no_data`
   status envelopes; synthesizes what-changed / unresolved / next-actions with single-source rows
   marked provisional.
4. **SAM chat orchestration (E2, PR21)** — five autopilot tools (start/get/list/cancel/resume)
   as new MCP tool definitions in the `report-autopilot-tools.ts` family adapted into SAM chat
   via the existing `adaptMcpTool` path (project-scoped auth, tracker dedup, per-turn recovery),
   **not registered on the public MCP route** (run-starters stay deferred per source plan §22 /
   repo plan §4). The workflow allowlist becomes the shared `AUTOPILOT_WORKFLOW_TYPES` const
   enforced at three layers (Zod trust boundary, SAM tool schema, service registry
   fail-closed). Chat starts record `trigger: "sam_chat"`.

Key grounding facts discovered during planning (they shape the design):

- **The E0 runtime is complete and battle-tested** (`src/server/features/autopilot/`): the
  step executor enforces `AUTOPILOT_MAX_STEPS = 12`, `AUTOPILOT_MAX_TOOL_CALLS = 20`,
  `AUTOPILOT_WALL_CLOCK_MS = 15min`, `AUTOPILOT_MAX_ATTEMPTS = 3`; collect steps dual-gate
  against the attempt's source-version pin (re-assembled from GSC/GA4/rank/audit/backlinks
  versions); the synthesis firewall (`assertSynthesisInput`) makes cross-attempt or
  mixed-version synthesis structurally impossible. New workflows are pure data — definitions
  registering through `registerAutopilotWorkflow` — the executor does not change.
- **Existing synthesize steps are deterministic** (`autopilotWorkflows.ts:211`): they build
  recommendations via pure functions (`growthRecommendations`/`trafficRecommendations`) and
  `serializeRecommendations`, record `toolCalls: 1` accounting + `promptVersion: 1`, and the
  serializer **already bans causal verbs for observational evidence**
  (`assertObservationalSafe`, BANNED_CAUSAL list in `autopilotSerializer.ts`). New workflows
  inherit this enforcement rather than inventing one.
- **`WORKFLOW_PROMPTS` (`autopilotWorkflowContent.ts:15`) are frozen prompt contracts
  asserted in tests but not consumed by any executor path today** — new workflows extend this
  record the same way (observational phrasing mandated in the prompt text, tested).
- **`AUTOPILOT_WORKFLOW_TYPES` (`src/shared/autopilot.ts:8`) is already the single workflow
  identity list** consumed by shared labels/descriptions, the SAM Autopilot tab's picker, and
  `isAutopilotWorkflowType`. Extending it (plus labels/descriptions records) makes the allowlist
  one shared definition — exactly what FR-011 requires.
- **`startAutopilotRunSchema` (`src/types/schemas/autopilot.ts:3`) currently accepts any string
  ≤ 120 as `workflowType`**; the service fails closed on unknown types via registry lookup
  (`AutopilotService.ts:97`). The allowlist task tightens the Zod enum to
  `AUTOPILOT_WORKFLOW_TYPES` so trust boundaries reject before the service runs.
- **No schema change is required**: `autopilot_runs.workflowType` is a text column;
  `trigger` is a text column (`AutopilotService.ts:120` writes `trigger: input.trigger ??
  "manual"`); attempts/steps are workflow-agnostic. Source plan §10 confirms "E workflow
  definitions — no new schema required."
- **`reportSections.ts` collectors return honest status envelopes** (READY with data, or
  `unavailable("not_connected" | "no_coverage" | "provider_failed" | "no_data")`) — the
  monthly-review workflow reuses them directly for zero/missing/unavailable preservation
  (G9) and never touches providers itself.
- **`adaptMcpTool` (`samChatTools.ts:100`) strips `projectId` from the model-facing schema and
  injects the session's project server-side**; `FRESH_READ_TOOLS` (currently
  `get_audit_status`) disables the dedup cache for progress reads over mutable workflow state —
  the run get/list tools must join that set (a cached "running" snapshot would lie on every
  repeat poll).
- **SAM builds the auth context the MCP handlers need** (`SamChatAgent.ts:363`:
  `buildFirstPartyMcpAuthContext` with userId/userEmail/organizationId) — the run-starting
  tools get identical scoping, metering, and tracker semantics as every other adapted tool.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Node 24 / Cloudflare Workers runtime

**Primary Dependencies**: existing autopilot runtime (`AutopilotService`, `stepExecutor`,
`autopilotTypes` registration seam, `synthesisFirewall`, `autopilotSerializer`,
`autopilotWorkflowContent`), Cloudflare Workflows (`AutopilotWorkflow` entrypoint — unchanged),
existing intelligence repositories (`OpportunityRepository`, `InsightRepository`), existing
audit repository (`AuditRepository`), existing reports collectors (`reportSections.ts`),
existing SAM chat tool adapter surface (`samChatTools.ts` `adaptMcpTool` +
`buildSamMcpTools`), existing MCP tool patterns (`withMcpProjectAuth`, `mcpResponse`,
`formatMcpTable`), Zod 4, TanStack Query (SAM Autopilot tab polling), Vitest 3 + Playwright

**Storage**: **no new tables, no migrations** — the existing
`src/db/autopilot.schema.ts` + `src/db/pg/autopilot.schema.ts` runs/attempts/steps triples
absorb new `workflowType` values and a new `trigger` value (`sam_chat`, ≤ 40 chars per the
existing column semantics). D1/PG parity is untouched (P3–P5 satisfied by no-op). Frozen step
evidence is JSON-serializable payload in the existing `evidenceJson` columns; its internal
shapes are contract-pinned in [contracts/workflow-definitions.md](./contracts/workflow-definitions.md).

**Testing**: Vitest colocated (`*.test.ts`); existing suites extended, new suites:
`autopilotWorkflows.test.ts` (extended for three new defs + prompts), serializer firewall
extension tests (causal-verb/uplift bans over new outputs), monthly-review evidence-envelope
tests (status matrix), SAM autopilot tool adapter tests
(mirroring `report-autopilot-tools.test.ts` + `samChatTools.test.ts` patterns: projectId
injection, allowlist rejection, FRESH_READ behavior, trigger provenance),
`serverFunctions/autopilot.authorization.test.ts` (unchanged shape still green), Playwright
`e2e/sam-autopilot.spec.ts` (workflow picker shows new types; start → poll → cancel/resume
lifecycle). Quality gates: `pnpm types:check` + `pnpm oxlint` + full autopilot suite + parity
no-op confirmation (P45).

**Target Platform**: Cloudflare Workers (D1 + PG deployments); existing Cloudflare Workflow
binding (`AUTOPILOT_WORKFLOW`) is the only executor — unchanged (P37).

**Project Type**: web-application (TanStack Start full-stack)

**Performance Goals**: every workflow fits the existing envelopes (≤ 12 steps, ≤ 20 tool
calls, 15-minute wall clock, ≤ 3 attempts — all enforced by the untouched executor); SAM tool
calls are stored reads + one workflow-instance create (no provider I/O); monthly-review
collect reuses six existing repository/collector reads per period (two periods), all
project-scoped indexed lookups.

**Constraints**: G10 (no render-time paid reads — workflow steps read stored data only; SAM
tool handlers start runs, they never enrich); G3/P25 (workflows consume stored evidence — no
detector logic in workflow definitions); P26 (impact/confidence stay separate in every
recommendation); P27 (facts vs recommendations distinguishable in output shapes); P28
(absent audit coverage → explicit outcome, never "no issues"); P35 (allowlist + budgets —
inherited + tightened); P38–P39 (project scoping on all five tools via
`withMcpProjectAuth`); P41–P42 (posthog `autopilot:start`/`autopilot:complete` events +
`[autopilot:*]` console logs already exist — trace stays observability; run/attempt/step
ledger authoritative); P43–P45 (TDD, gates); P46 (observational language, single-source
provisional marking); P50 (MCP route registration, cadenced scheduling, E1d competitor-gap all
out of scope).

**Scale/Scope**: six workflow types total (three existing + three new) across one picker;
manual start MVP (chat + UI); runs are per-project, low-volume; frozen evidence payloads
bounded by collector caps (existing `COMPLETED_OPPORTUNITIES_CAP`, MCP row limits, top-N
correlate caps — new workflows use ≤ 10-item ranked lists like the existing ones).

**Open technical decisions** (resolved in [research.md](./research.md)):
- R1: allowlist mechanics — where the single workflow-type enum lives and which layers
  enforce it (Zod schema, SAM tool schema, service registry).
- R2: synthesis mechanics for new workflows — deterministic-first pure builders vs. LLM step
  execution, toolCalls accounting, and how the causal-verb/uplift bans extend.
- R3: technical-SEO evidence sources — which stored audit reads, and the exact
  coverage/staleness semantics (P28 honest absence).
- R4: monthly-review evidence windows — month/prior-month derivation, which collectors to
  reuse, and non-additive metric handling (P23).
- R5: SAM tool placement — new MCP definitions adapted into SAM without public MCP-route
  registration; fresh-read vs cached treatment of get/list; chat trigger provenance.
- R6: attempt-pin coverage for the new collect surfaces (audit + reports collectors) — what
  pins monthly-review evidence so mid-run source changes invalidate correctly.
- R7: UI surface changes for new workflow types — labels/descriptions and evidence rendering
  in `SamAutopilotTab` / `autopilotEvidence.ts`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Post-Phase-1 re-check (2026-10-04): PASS.** Design artifacts ([research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)) re-verified after design:
the allowlist is one shared const enforced at three layers with the service registry still
fail-closed (P35 confirmed in contracts/workflow-definitions.md §1); all three workflows are
data-only definitions over stored evidence — no executor, firewall, or budget change, no
side-effect steps (P2/P34 confirmed in workflow-definitions §2); technical-SEO's
`auditCoverage` state machine makes absence explicit and never an invented "no issues"
(P28/G9 confirmed §3.2); monthly-review reuses the reports collectors' honest envelopes
verbatim and never differences non-additive metrics (P21/P23/P46 confirmed §3.3); no schema
change (P3–P5 by no-op — data-model §5); the five SAM tools delegate to the same
AutopilotService methods via the existing adapter with project injection and fresh-read
polls (P1/P39 confirmed in contracts/sam-autopilot-tools.md §1–2); public MCP route stays
unchanged (P50 — deferred-later honored §3); no new providers, no live provider I/O in any
step (P6/G10). No violations; no complexity-tracking entries required.

| Gate / Principle | Requirement for this feature | Status |
| --- | --- | --- |
| P1/P2 (layers, no competing architecture) | Workflows are data-only definitions registering through the existing seam; executor, firewall, budgets, Cloudflare Workflow untouched; SAM tools adapt through the existing `adaptMcpTool` path delegating to the same `AutopilotService` methods the UI fns use | PASS by design |
| P3–P5 (DB law) | No schema changes — runs/attempts/steps absorb new `workflowType`/`trigger` values; parity tests stay green by no-op | PASS — data-model.md |
| P6–P10 (provider law) | No new providers; workflow steps make zero provider calls (stored reads only); no DataForSEO classification touched | PASS |
| G10/P13 (no render-time paid work) | Collect steps read repositories/collectors over stored data; SAM start tool creates a workflow instance (scheduled-execution path, not render-time); no enrichment in any step | PASS |
| P21/P23 (zero-row ≠ failure; non-additive metrics) | Monthly-review reuses collectors with honest READY/unavailable envelopes; GA4 totals come from stored summary aggregates, never summed across grains | PASS — research R4 |
| P25–P28 (intelligence law) | No detector logic in workflows — they consume stored opportunities/insights/audit; impact/confidence separate (P26); facts vs recommendations separated in output shapes (P27); absent audit → explicit no-coverage, never an invented "no issues" (P28) | PASS |
| P34–P35 (autopilot law) | Orchestrator over frozen evidence only; explicit allowlist (shared const), bounded steps/tool calls/attempts — inherited from the untouched executor; no unconstrained agency (E2 exposes only the five bounded tools) | PASS |
| P36/E1d (competitor gap gated) | Competitor-gap workflow explicitly out of scope; allowlist excludes it structurally (not in the const) | PASS |
| P37 (Cloudflare-native execution) | Existing Cloudflare Workflow binding is the sole executor; no queue/cron/third-party scheduler added | PASS |
| P38–P39 (security, project scope) | All five SAM tools run `withMcpProjectAuth`; `adaptMcpTool` injects the session project server-side (model cannot target another project); chat runs are project-scoped rows like UI runs | PASS |
| P41–P42 (trace, ledgers) | Existing posthog events + `[autopilot:*]` logs extended only with new workflow types/trigger value; run/attempt/step ledger remains authoritative | PASS |
| P43–P45 (tests, gates) | TDD: workflow definition tests, firewall extension, evidence-envelope matrix, tool adapter tests, auth tests, E2E lifecycle; `pnpm types:check` + `pnpm oxlint` + suites | PASS — quickstart.md |
| P46–P47 (truthfulness) | Serializer's observational-only enforcement extended to new outputs; single-source rows marked provisional; evidence records carry periods and per-source status | PASS |
| G9 (failure never zero) | Collectors' unavailable envelopes flow into frozen evidence and synthesis unchanged; banned from coercing to zero | PASS |
| P50 (scope discipline) | No MCP-route registration of run-starters, no cadenced scheduling, no E1d, no new schema, no UI redesign — evidence rendering extended minimally | PASS |

**Violations**: none. No complexity-tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/013-autopilot-workflows/
├── plan.md                     # This file
├── research.md                 # Phase 0 output (R1–R7)
├── data-model.md               # Phase 1 output (evidence payloads, no-schema rationale)
├── quickstart.md               # Phase 1 output (validation scenarios)
├── contracts/
│   ├── workflow-definitions.md # E1a/E1b/E1c steps, evidence shapes, allowlist enum
│   └── sam-autopilot-tools.md  # E2 five tools: schemas, adaptation, fresh-read, provenance
└── tasks.md                    # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── shared/
│   └── autopilot.ts                # + 3 workflow types in AUTOPILOT_WORKFLOW_TYPES,
│                                   #   + labels/descriptions entries (allowlist single source)
├── server/features/autopilot/services/
│   ├── autopilotWorkflowContent.ts # + pure content: prompts for 3 new workflows,
│   │                               #   correlate/recommendation builders, month-window derivation
│   ├── autopilotWorkflows.ts       # + 3 definitions (collect/correlate/synthesize steps),
│   │                               #   + shared evidence collectors exported for reuse
│   ├── autopilotWorkflows.test.ts  # extended: defs, prompts, output bans
│   └── autopilotSerializer.test.ts # extended: causal-verb/uplift bans over new outputs
├── server/features/autopilot/services/
│   └── autopilotMonthlyReview.test.ts    # NEW: evidence-envelope + window-derivation suites
├── server/mcp/tools/
│   ├── autopilot-run-tools.ts      # NEW: start/get/list/cancel/resume MCP definitions
│   │                               #   (withMcpProjectAuth; NOT registered on MCP route)
│   └── autopilot-run-tools.test.ts # NEW: allowlist, scoping, output-shape tests
├── server/features/sam/
│   ├── samChatTools.ts             # + adapt the five tools into buildSamMcpTools;
│   │                               #   get/list run tools join FRESH_READ_TOOLS
│   └── samChatTools.test.ts        # extended: projectId injection, fresh-read, provenance
├── types/schemas/
│   └── autopilot.ts                # workflowType: z.enum(AUTOPILOT_WORKFLOW_TYPES) (R1)
├── client/features/sam/
│   ├── SamAutopilotTab.tsx         # new workflow types render via existing picker (minimal)
│   └── autopilotEvidence.ts        # + renderers for new evidence shapes (changed/unresolved/
│                                   #   next-actions; technical plan; refresh candidates)
└── e2e/
    └── sam-autopilot.spec.ts       # NEW: picker shows 6 types; start→poll→cancel→resume
```

**Structure Decision**: single-project web application (existing monorepo layout). All new code
lands inside the existing `autopilot` feature folder, the existing MCP `tools/` family, and the
existing SAM feature folder — no new top-level directories. The five run tools live as MCP tool
definitions (same shape as `report-autopilot-tools.ts`) so SAM adapts them exactly like every
other tool, while their public MCP-route registration stays deferred; the workflow content
follows the established split — pure content in `autopilotWorkflowContent.ts`, collection +
definitions in `autopilotWorkflows.ts` — so the new workflows are diff-sized additions to
familiar files.

## Complexity Tracking

> Not applicable — Constitution Check has no violations to justify.