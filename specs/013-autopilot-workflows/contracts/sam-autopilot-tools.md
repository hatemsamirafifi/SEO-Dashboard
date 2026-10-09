# Contract: SAM Autopilot Tools (E2 — start / get / list / cancel / resume)

**Feature 013 · Phase 1 contract.** Governs the five chat-exposed autopilot operations. The
tools are MCP-shaped definitions adapted into the SAM agent — **not registered on the public
MCP route** (run-starters stay deferred per source plan §22 / repo plan §4).

## 1. Tool definitions (`src/server/mcp/tools/autopilot-run-tools.ts`)

All five follow the `report-autopilot-tools.ts` definition shape:
`withMcpProjectAuth` handler (project-scoped auth identical to every other tool — P39),
`mcpResponse` output (text + structuredContent + meta with deep link `/p/<projectId>/sam`),
input validated by Zod, output wrapped by `looseObjectOutputSchema` + `optionalMetaOutputSchema`.

| # | Tool name | Delegation (AutopilotService) | Input schema | Output | Annotations |
| --- | --- | --- | --- | --- | --- |
| 1 | `start_autopilot_run` | `startAutopilotRun({ projectId, organizationId, userId, userEmail, workflowType, trigger: "sam_chat" })` | `{ workflowType: z.enum(AUTOPILOT_WORKFLOW_TYPES) }` (`projectId` stripped/injected by the adapter) | `{ runId, workflowType }` + text "Run `<id>` (`<type>`) started." | `readOnlyHint: false` |
| 2 | `get_autopilot_run` | `getAutopilotRun` | `{ runId }` | `{ run, attempts, steps }` + step table text (mirrors the existing `get_autopilot_run` MCP tool's shape: id/kind/name/status columns) | `readOnlyHint: true` |
| 3 | `list_autopilot_runs` | `listAutopilotRuns` | `{}` | `{ runs }` + bounded table (id, workflowType, status) | `readOnlyHint: true` |
| 4 | `cancel_autopilot_run` | `cancelAutopilotRun` | `{ runId }` | `{ status }` + text | `readOnlyHint: false` |
| 5 | `resume_autopilot_run` | `resumeAutopilotRun` | `{ runId }` | `{ runId, resumed }` + text | `readOnlyHint: false` |

Rules:

1. **No new service methods.** Every tool delegates to the exact `AutopilotService` methods
   the UI server functions call (`src/serverFunctions/autopilot.ts`) — no parallel
   orchestration path (P1/P2, spec FR-010).
2. **Allowlist** is the shared enum (workflow-definitions.md §1): the start tool's schema
   rejects non-allowlisted types before the handler runs (curated `TOOL_INPUT_INVALID`
   feedback); the service's registry check remains defense in depth (FR-011, SC-004).
3. **No `side_effect` on run rows by tools beyond the service's own semantics** — cancel's
   terminal-state idempotency and resume's running/cancelled-only rule are inherited service
   behaviors; the tools add no state machine of their own.
4. **Provenance**: chat starts pass `trigger: "sam_chat"` (existing text column; UI remains
   `"manual"`) (FR-015, R5).

## 2. Adaptation into SAM (`src/server/features/sam/samChatTools.ts`)

1. All five definitions are adapted via the existing `adapt()` helper inside
   `buildSamMcpTools` — project injection (`projectId` stripped from the model-facing schema,
   session project injected server-side), tracker dedup + execution logging, guarded execute
   with the single bounded retry, per-turn recovery state: all inherited unchanged
   (FR-014/P39 — the model cannot target another project).
2. **Fresh-read set**: `get_autopilot_run` and `list_autopilot_runs` are added to
   `FRESH_READ_TOOLS` — run polls are progress reads over mutable workflow state; a cached
   snapshot would repeat stale "running" state per turn until DO eviction (the exact failure
   mode the set exists for). Start/cancel/resume stay cacheable (their results are terminal
   facts about an action).
3. **Descriptions route the model honestly**: start's description names the allowlisted
   types and says what each does (labels from `AUTOPILOT_WORKFLOW_DESCRIPTIONS`); get's
   description says it returns live run state and that waiting is poll-then-answer; no
   orchestration guidance that suggests autonomous multi-run chaining ("start one workflow at
   a time; wait for a terminal state before summarizing").
4. **Billing**: tool executions draw down credits exactly like every adapted tool (existing
   guarded runner + metering); run execution itself is budgeted by the untouched autopilot
   executor (FR-012 — no new budget paths).
5. **No live provider I/O**: handlers start/read/stop stored run rows and create workflow
   instances; no step of any workflow performs provider reads (G10, FR-015, SC-005).

## 3. Public MCP route

`src/server/mcp/server.ts` is **unchanged** — zero new registrations. The definitions exist in
the shared shape so a future product decision can register them without rewrite (deferred,
not this package).

## 4. Client evidence rendering (R7)

`src/client/features/sam/autopilotEvidence.ts` gains renderers for the three new evidence
shapes (data-model §2.4–2.9):

- technical-SEO: facts block (coverage state + ranked issues) visually separated from
  recommendation cards (P27);
- monthly-review: changed / unresolved / next-actions sections; per-source status chips
  render the envelope reasons (`not_connected` / `no_coverage` / `provider_failed` /
  `no_data` — never zeros); `single_source` rows carry a provisional tag;
- content-refresh: existing recommendation cards.

`SamAutopilotTab.tsx` requires no structural change (picker iterates the shared const);
labels/descriptions for the new types come from the shared records.

## 5. Authorization & audit

- Wrong-project run access → `NOT_FOUND` (service's `getRunForProject` semantics, inherited).
- Unauthenticated → existing `withMcpProjectAuth` rejection.
- Posthog `autopilot:start` (existing event in `AutopilotService.ts`) carries the new
  workflow types and trigger value automatically; no new event names; `[autopilot:*]` console
  logs unchanged (P41 — observability; ledger authoritative, P42).

## 6. Acceptance mapping

| Spec FR | Contract clause |
| --- | --- |
| FR-010 (same services, adapter patterns) | §1.1, §2.1 |
| FR-011 (allowlist, fail closed) | §1.2, §2.1 |
| FR-012 (existing budgets) | §2.4 |
| FR-013 (durable reads, ledger authoritative) | §1.2, §2.2, §5 |
| FR-014 (project scoping) | §2.1, §5 |
| FR-015 (no paid reads, chat provenance) | §1.1, §2.5 |
| SC-003 (E2E lifecycle) | §1, §2 |
| SC-004 (allowlist rejections) | §1.2 |