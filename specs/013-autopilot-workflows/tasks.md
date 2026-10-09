---
description: "Task list for spec 013 — Autopilot Workflows + SAM Orchestration"
---

# Tasks: Autopilot Workflows + SAM Orchestration (013)

**Input**: Design documents from `/specs/013-autopilot-workflows/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md,
data-model.md, contracts/

**Tests**: This repository is constitutionally TDD (P43/P45 — unit/repository/service/UI/E2E
mandatory categories). Test tasks are included and MUST be written first (failing) before the
paired implementation task in the same phase.

**Organization**: Tasks are grouped by user story to enable independent implementation and
testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- File paths are relative to repository root

## Path Conventions

- Autopilot feature: `src/server/features/autopilot/{services,repositories}/`
- SAM feature: `src/server/features/sam/`
- MCP tool definitions: `src/server/mcp/tools/` (public route `src/server/mcp/server.ts` —
  UNCHANGED this feature)
- Shared workflow identity: `src/shared/autopilot.ts`
- Zod trust boundaries: `src/types/schemas/autopilot.ts`
- Client: `src/client/features/sam/`
- E2E: `e2e/`
- DB: **no schema changes** (`src/db/autopilot.schema.ts` untouched; parity green by no-op)

---

## Phase 1: Setup (Shared Infrastructure — the allowlist)

**Purpose**: The single allowlist const + trust-boundary enum + language-ban extension —
every story consumes these (contracts/workflow-definitions.md §1, research R1/R2).

### Tests for Setup (write FIRST, must FAIL)

- [X] T001 [P] Create `src/shared/autopilot.test.ts` (failing) with cases for the six-entry
  list: `AUTOPILOT_WORKFLOW_TYPES` equals
  `["growth_plan", "quick_wins", "traffic_drop", "content_refresh", "technical_seo",
  "monthly_review"]` in order; `AUTOPILOT_WORKFLOW_LABELS` and
  `AUTOPILOT_WORKFLOW_DESCRIPTIONS` have exactly one entry per type;
  `isAutopilotWorkflowType("competitor_gap")` is `false` (structural G5/P36 exclusion)
- [X] T002 [P] Create `src/types/schemas/autopilot.test.ts` (failing; follow the pattern of
  `src/types/schemas/projects.test.ts`) with Zod cases: `startAutopilotRunSchema` accepts
  each of the six workflow types with `trigger` ≤ 40 chars and rejects non-allowlisted
  values (`"competitor_gap"`, `"arbitrary_workflow"`, empty string) — the enum is
  `z.enum(AUTOPILOT_WORKFLOW_TYPES)` (contracts/workflow-definitions.md §1.1)
- [X] T003 [P] Add failing language-ban cases in
  `src/server/features/autopilot/services/autopilotSerializer.test.ts`: a helper
  `containsUpliftPattern(text)` (matching `/\d+\s*%/`) rejects synthesized recommendation
  JSON containing `"increase traffic by 25%"` and passes `"Sessions decreased during the
  same period"`; new workflows' builders must emit only
  `expectedImpact: { kind: "qualitative" }` (assert the serializer rejects a `quantified`
  impact without basis, per data-model §2.3)

### Implementation for Setup

- [X] T004 Extend `src/shared/autopilot.ts`: add `content_refresh`, `technical_seo`,
  `monthly_review` to `AUTOPILOT_WORKFLOW_TYPES` plus their
  `AUTOPILOT_WORKFLOW_LABELS`/`AUTOPILOT_WORKFLOW_DESCRIPTIONS` entries (T001 turns green)
- [X] T005 Change `workflowType` in `startAutopilotRunSchema`
  (`src/types/schemas/autopilot.ts`) from `z.string().min(1).max(120)` to
  `z.enum(AUTOPILOT_WORKFLOW_TYPES)`; keep `trigger: z.string().max(40).optional()` (T002
  turns green); confirm the existing
  `src/serverFunctions/autopilot.authorization.test.ts` stays green (no fn signature change)
- [X] T006 Add `containsUpliftPattern` export to
  `src/server/features/autopilot/services/autopilotSerializer.ts` (pure regex helper beside
  `containsBannedCausalVerb`; no behavior change to existing exports) (T003 turns green)

**Checkpoint**: T001–T003 fail→pass via T004–T006; existing autopilot + sam suites still
green. Story phases may start.

---

## Phase 2: User Story 1 — Content-refresh workflow (Priority: P1) 🎯 MVP

**Goal**: A fourth registered workflow (`content_refresh`) that collects stored engine state,
ranks refresh candidates, and synthesizes observational recommendations through the existing
serializer — runnable end-to-end via the UI start path.

**Independent Test**: quickstart V1 + V2 content-refresh fixtures — run
`pnpm exec vitest run src/server/features/autopilot/services/autopilotWorkflows.test.ts` with
seeded opportunities/insights: registration shape, ranked order
(priority→impact→confidence→id), ≤ 10 candidates, observational output, `toolCalls: 1`, no
provider clients invoked.

### Tests for User Story 1 (write FIRST, must FAIL)

- [X] T007 [US1] Create `src/server/features/autopilot/services/autopilotContentRefresh.test.ts`
  (failing) with `content_refresh` cases (follow the growth_plan drive pattern in
  `autopilotWorkflows.test.ts`: mock
  `OpportunityRepository.listActiveByProject` + `InsightRepository.listUnresolvedByProject`
  via `vi.spyOn`, `seedRun()` + `driveRunToCompletion` + `fakeRunner()`):
  registration (dense seqs `[0,1,2]`, kinds collect/correlate/synthesize, no side-effect
  steps); correlate ranks page-bearing opportunities by
  `priority (Critical>High>Medium>Low) → impactScore desc → confidenceScore desc → id` capped
  at 10 (fixture with 12 candidates → 10 ranked, order asserted); synthesize emits
  `evidenceType: "observational"`, `promptVersion: 1`, `toolCalls: 1`, recommendations cite
  metrics+periods from the frozen evidence, zero `containsBannedCausalVerb` and zero
  `containsUpliftPattern` hits over all recommendation JSON (SC-001), every `expectedImpact`
  is `{ kind: "qualitative" }`, impact and confidence remain separate fields (P26)
- [X] T008 [US1] Add a failing `WORKFLOW_PROMPTS` case in the new suite: the
  `content_refresh` prompt exists, mandates observational phrasing ("decreased during the
  same period", "consistent with"), and passes `containsBannedCausalVerb` (the existing
  prompt-loop test in `autopilotWorkflows.test.ts` iterates all entries generically —
  data-model §2.3)

### Implementation for User Story 1

- [X] T009 [US1] Add to
  `src/server/features/autopilot/services/autopilotWorkflowContent.ts`: the
  `content_refresh` `WORKFLOW_PROMPTS` entry + pure helper
  `refreshRecommendations(opportunities, rankedIds)` (observational builder, qualitative
  impacts only, priority/impact/confidence from stored rows)
- [X] T010 [US1] Add `contentRefreshDef()` to
  `src/server/features/autopilot/services/autopilotWorkflows.ts` per
  contracts/workflow-definitions.md §3.1: collect reuses the existing exported
  `collectEngineState(ctx.projectId)`; correlate ranks candidates (≤ 10) from page-related
  opportunity types; synthesize uses `serializeRecommendations(refreshRecommendations(...))`
  with `evidenceType: "observational"`, `promptVersion: 1`, `toolCalls: 1`; register the def
  in `ensureAutopilotWorkflowsRegistered()` (T007–T008 turn green)

**Checkpoint**: quickstart V1–V2 green for content_refresh; the workflow is startable via the
existing UI (`SamAutopilotTab` picker renders the new type from the shared const — no tab code
touched in this story).

---

## Phase 3: User Story 2 — Technical-SEO workflow (Priority: P2)

**Goal**: A fifth registered workflow (`technical_seo`) that collects stored audit evidence
with the honest `auditCoverage` state machine and separates facts from recommendations.

**Independent Test**: quickstart V2 technical-SEO fixtures — drive the workflow with
`AuditRepository.getLatestAuditForProject`/`getIssuesForAudit` mocked for all four coverage
states (`never_run`, `stale_or_failed`, `empty_crawl`, `ready`): non-ready states produce the
insufficient-coverage block and zero issue-plan recommendations while the run completes;
`ready` produces severity-ranked issues + facts/recommendations separation; zero provider
clients invoked.

### Tests for User Story 2 (write FIRST, must FAIL)

- [X] T011 [US2] Create
  `src/server/features/autopilot/services/autopilotTechnicalSeo.test.ts` with failing
  `technical_seo` cases (drive pattern + `vi.spyOn(AuditRepository,
  "getLatestAuditForProject")` / `vi.spyOn(AuditRepository, "getIssuesForAudit")`):
  `never_run` fixture (latest audit `null`) → collect evidence `auditCoverage.state =
  "never_run"`, synthesize emits exactly one insufficient-coverage recommendation and zero
  issue-plan recommendations, run status `completed` (honest absence ≠ failure, P28/P21);
  `stale_or_failed` fixture (status `"running"`) → `{ state: "stale_or_failed", auditStatus:
  "running" }` same honest path; `empty_crawl` fixture (terminal, `pagesCrawled: 0`) →
  `{ state: "empty_crawl" }` same honest path; `  ready` fixture (terminal, issues seeded) →
  issues aggregated by severity+type with counts, `rankedIssues` ordered
  `critical>warning>info` (audit schema vocabulary — P48: repo wins) then count desc capped at 10, synthesize `facts`
  (coverage + ranked issues) separate from `recommendations` (P27), `evidenceType:
  "observational"`, `toolCalls: 1`, zero causal/uplift hits (SC-001/SC-006)
- [X] T012 [US2] Add a failing case (new suite): `technical_seo` correlate also ranks
  stored technical opportunities (`rankedOpportunityIds` per §2.2 order, ≤ 10) alongside
  ranked issues, and the coverage state is echoed verbatim into correlate evidence
  (contracts/workflow-definitions.md §3.2)

### Implementation for User Story 2

- [X] T013 [US2] Add to
  `src/server/features/autopilot/services/autopilotWorkflowContent.ts`: the
  `technical_seo` `WORKFLOW_PROMPTS` entry + pure helpers
  `auditCoverageOf(latestAudit)` (state machine: `never_run` | `stale_or_failed(auditStatus)`
  | `empty_crawl` | `ready(auditId, pagesCrawled, completedAt)` per data-model §2.4),
  `rankIssues(aggregated)` (audit severity order `critical>warning>info`, count desc,
  ≤ 10, normalizing `{issueType, severity, pages}` to `{severity, type, count}`),
  `technicalRecommendations(coverage, rankedIssues, opportunities, rankedOpportunityIds)`
  (qualitative impacts, insufficient-coverage block for non-ready states)
- [X] T014 [US2] Add `technicalSeoDef()` to
  `src/server/features/autopilot/services/autopilotWorkflows.ts` per
  contracts/workflow-definitions.md §3.2 + plan.md R3: collect calls
  `AuditRepository.getLatestAuditForProject(projectId)` and (only when the audit is
  completed with pages crawled) `getIssueTypePageCountsForAudit(auditId)` — the exact
  aggregated surface the dashboard card consumes — plus the existing `collectEngineState`; correlate ranks issues
  and technical opportunities; synthesize separates `facts` from `recommendations` via
  `serializeRecommendations(technicalRecommendations(...))`; register in
  `ensureAutopilotWorkflowsRegistered()` (T011–T012 turn green)

**Checkpoint**: quickstart V2 green for technical_seo; the four coverage fixtures prove the
no-invented-"no issues" invariant end-to-end.

---

## Phase 4: User Story 3 — Monthly-review workflow (Priority: P3)

**Goal**: A sixth registered workflow (`monthly_review`) that freezes two-window evidence
from the reports collectors and synthesizes changed/unresolved/next-actions with honest
envelopes, provisional single-source tags, and no differenced ratios.

**Independent Test**: quickstart V2 monthly-review fixtures — drive the workflow with the
`reportSections` collectors mocked: both-windows-READY → delta rows for additive metrics;
one-window-unavailable → unavailable rows (never zero-delta); ctr/position side-by-side;
`single_source` → provisional tag; empty project → honest nothing-to-review completion.

### Tests for User Story 3 (write FIRST, must FAIL — one new suite, written in order)

- [X] T015 [US3] Create `src/server/features/autopilot/services/autopilotMonthlyReview.test.ts`
  (failing) with the pure-function fixtures first (no DB): month-window derivation — for a
  run at 2026-10-04: `month = { from: "2026-09-01", to: "2026-09-30" }`,
  `prior = { from: "2026-08-01", to: "2026-08-31" }`; year boundary (run at 2026-01-15 →
  December/November 2025); leap-year February; late starts still target complete previous
  months (SC-008 windows)
- [X] T016 [US3] Add failing cases to the same suite for the changed-row builder (pure,
  data-model §2.8): both windows READY → delta rows for additive metrics only (clicks,
  impressions, sessions, pageViews, keyEvents, transactions); one window
  `unavailable("no_coverage")` → an unavailable row carrying the reason, never a zero-delta
  (G9/SC-006); `ratios` (ctr, position, engagement) appear side-by-side with `monthValue` +
  `priorValue` and NO delta field (P23); agreement vocabulary
  `corroborated | single_source` (existing vocabulary, data-model §2.8); `unresolved` rows
  from Critical/High open opportunities + unresolved insights only
- [X] T017 [US3] Add failing drive cases to the same suite (DB pattern from
  `autopilotWorkflows.test.ts`: hoisted libsql mock, `setupAutopilotTestDb`, `vi.spyOn` on
  the collector imports from `@/server/features/reports/services/reportSections`): drive
  `monthly_review` with collectors returning READY envelopes for both windows → completed
  run, synthesize `summary.changed` rows carry `delta`, `summary.unresolved`,
  `summary.nextActions` recommendations citing source rows, `single_source` rows tagged
  provisional (P46), `evidenceType: "observational"`, `toolCalls: 1`, zero causal/uplift
  hits (SC-001); empty-project fixture (all collectors unavailable, no
  opportunities/insights) → run completes with honest nothing-to-review summary, never
  fabricated zeros (P21)

### Implementation for User Story 3

- [X] T018 [US3] Add to
  `src/server/features/autopilot/services/autopilotWorkflowContent.ts`: the
  `monthly_review` `WORKFLOW_PROMPTS` entry + pure helpers
  `deriveMonthWindows(now: Date)` (previous complete UTC month + its predecessor),
  `buildChangedRows(month, prior)` (envelope-aware: both-READY deltas, unavailable rows
  otherwise, `ratios` side-by-side), `monthlyReviewRecommendations(unresolved, monthLabel)`
  (next-actions citing source rows, provisional tags for single_source)
- [X] T019 [US3] Add `monthlyReviewDef()` to
  `src/server/features/autopilot/services/autopilotWorkflows.ts` per
  contracts/workflow-definitions.md §3.3 + plan.md R4: collect calls
  `collectSearchVisibility`, `collectTrafficAndConversions` for both windows in parallel,
  `collectOverviewParts`, `collectInsights`, `collectOpportunities` (imports from
  `@/server/features/reports/services/reportSections`; envelopes frozen verbatim — never
  coerced); correlate runs `buildChangedRows` + unresolved collection; synthesize emits the
  three-section summary via `serializeRecommendations(monthlyReviewRecommendations(...))`;
  register in `ensureAutopilotWorkflowsRegistered()` (T015–T017 turn green; re-run
  `pnpm exec vitest run src/server/features/reports` — collectors' own suites untouched
  green)

**Checkpoint**: quickstart V2 green for monthly_review; evidence envelopes flow verbatim from
collectors into frozen evidence (SC-006/SC-008 provable from the fixtures).

---

## Phase 5: User Story 4 — SAM chat orchestration (Priority: P4)

**Goal**: The five autopilot tools (start/get/list/cancel/resume) exposed in SAM chat through
the existing adapter patterns — allowlisted, project-injected, fresh-read polls, chat
provenance, no public MCP-route registration.

**Independent Test**: quickstart V4 + V6 — with the model layer stubbed:
`autopilot-run-tools.test.ts` (allowlist, scoping, shapes) + `samChatTools.test.ts`
(injection, fresh-read, provenance) green; `git diff -- src/server/mcp/server.ts` empty;
Playwright `e2e/sam-autopilot.spec.ts` start→poll→cancel→resume lifecycle.

### Tests for User Story 4 (write FIRST, must FAIL)

- [X] T020 [P] [US4] Create `src/server/mcp/tools/autopilot-run-tools.test.ts` (failing,
  following the `report-autopilot-tools.test.ts` pattern: hoisted service mocks,
  `MCP_AUTH_CONTEXT_PROP` auth context, `normalizeObjectSchema`/`safeParseAsync`): the five
  tool definitions exist with the contract names/annotations
  (contracts/sam-autopilot-tools.md §1: start/resume/cancel `readOnlyHint: false`,
  get/list `readOnlyHint: true`); `start_autopilot_run` passes
  `trigger: "sam_chat"` (FR-015), accepts each allowlisted type, rejects
  `"competitor_gap"`/arbitrary strings at the Zod layer (SC-004), and rejects when
  `ProjectService.getProjectForOrganization` yields no project (scoping);
  `get_autopilot_run` on a wrong-project runId → `NOT_FOUND` (service mock returns null);
  `cancel_autopilot_run` delegates with the service's terminal-idempotency; outputs carry
  `structuredContent` + meta deep link `/p/<projectId>/sam`
- [X] T021 [P] [US4] Extend `src/server/features/sam/samChatTools.test.ts` with failing
  cases (stub the five defs at the shared-definition boundary like the audit-tools mock):
  all five tools are in the ToolSet; model-facing schemas omit `projectId` (session project
  injected server-side by `adaptMcpTool`, FR-014); `get_autopilot_run` +
  `list_autopilot_runs` bypass the dedup cache (FRESH_READ — call twice, handler runs
  twice; a cacheable control tool runs once); start/cancel/resume results remain
  cacheable; descriptions route the model honestly (start names the allowlisted types; no
  autonomous multi-run chaining guidance)

### Implementation for User Story 4

- [X] T022 [US4] Create `src/server/mcp/tools/autopilot-run-tools.ts` per
  contracts/sam-autopilot-tools.md §1 (definitions only — NOT registered in
  `src/server/mcp/server.ts`): `withMcpProjectAuth` handlers delegating to the exact
  `AutopilotService` methods the UI fns use (start → `startAutopilotRun({ ...,
  workflowType, trigger: "sam_chat" })`, get → `getAutopilotRun`, list →
  `listAutopilotRuns`, cancel → `cancelAutopilotRun`, resume → `resumeAutopilotRun`);
  `workflowType: z.enum(AUTOPILOT_WORKFLOW_TYPES)` input; `mcpResponse` outputs with
  step/run tables via `formatMcpTable` (mirror the existing `getAutopilotRunTool` text
  shape); output schemas via `looseObjectOutputSchema` + `optionalMetaOutputSchema`
  (T020 turns green)
- [X] T023 [US4] Wire the five tools into `src/server/features/sam/samChatTools.ts`:
  import from `autopilot-run-tools.ts`, add to `buildSamMcpTools`'s returned ToolSet via the
  existing `adapt()` helper; add `get_autopilot_run` and `list_autopilot_runs` to the
  `FRESH_READ_TOOLS` set (live polls must not serve cached "running" snapshots); start's
  adapted description names the six types from `AUTOPILOT_WORKFLOW_DESCRIPTIONS` and says
  one workflow at a time (T021 turns green); verify
  `git diff -- src/server/mcp/server.ts` is empty (no public registration)
- [X] T024 [P] [US4] Create `e2e/sam-autopilot.spec.ts` (failing, Playwright, following the
  `e2e/report-schedules.spec.ts` login/project fixtures): SAM Autopilot tab — picker shows
  all six workflow types with labels; start a `content_refresh` run → poll shows the live
  step checklist (attempt/step states render) → terminal state renders recommendation
  evidence; cancel an active run → status flips to `cancelled` truthfully; resume the
  cancelled run → run continues to `completed` (SC-003); zero-runs state shows setup
  guidance distinct from error
- [X] T025 [P] [US4] Extend `src/client/features/sam/autopilotEvidence.test.ts` with failing
  renderer cases per data-model §2.4–2.9: technical-SEO facts block (coverage state +
  ranked issues) visually separate from recommendation cards (P27); monthly-review
  changed/unresolved/next-actions sections with status chips for envelope reasons
  (`not_connected`/`no_coverage`/`provider_failed`/`no_data` — never zeros) and
  `single_source` provisional tags; content-refresh reuses existing
  `recommendationCards` output
- [X] T026 [US4] Implement the renderers in
  `src/client/features/sam/autopilotEvidence.ts` (extend `parseStepEvidence`'s mapping +
  new export functions following the existing `recommendationCards`/`correlationRows`
  shapes); wire them into `SamAutopilotTab.tsx`'s evidence area only — no structural tab
  changes, picker already iterates the shared const (T025 turns green; T024's evidence
  assertions turn green)

**Checkpoint**: quickstart V4 + V6 green; the five tools exist in SAM only, and the E2E
lifecycle round-trips through the durable run record.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T027 [P] Run quickstart V0–V7 validations and record outcomes; V0 must confirm no DB
  diff (`git status -- src/db/ drizzle/ drizzle-pg/` clean) and existing
  `report-autopilot-tools.test.ts` + `autopilot.authorization.test.ts` stay green
- [X] T028 Run full gates: `pnpm types:check`, `pnpm oxlint`, then
  `pnpm exec vitest run src/server/features/autopilot src/server/features/sam
  src/server/mcp/tools src/shared src/types/schemas/autopilot.test.ts
  src/client/features/sam src/db/schema-parity.test.ts`; confirm no-regression on the three
  existing workflows' drive fixtures (growth_plan/quick_wins/traffic_drop assertions
  untouched-green)
- [X] T029 [P] Security/overreach sweep (P34/P35/P38–P39 evidence): grep the new tool +
  workflow files for direct provider imports (must be none — stored reads only, G10/SC-005);
  confirm no workflow def contains `side_effect` steps; confirm
  `competitor_gap` appears in no allowlist, registration, or tool schema (G5/P36); confirm
  no raw provider payloads or cross-project ids can enter frozen evidence (collectors are
  project-scoped)
- [X] T030 [P] Verify `src/server/mcp/server.ts` and `wrangler.jsonc` unchanged (public MCP
  route gains no run-starters — plan §4 deferral; P37/P50) and no new cron/queue/scheduler
  was introduced anywhere in the diff

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — T001–T003 tests first, then T004–T006; **BLOCKS all
  stories** (the enum + language bans are consumed by every workflow test)
- **US1 (Phase 2)**: after Setup — MVP; T009 (content) before T010 (def)
- **US2 (Phase 3)**: after Setup; T013 → T014; shares two source files with US1
  (`autopilotWorkflowContent.ts`/`autopilotWorkflows.ts` — coordinate or serialize with
  US1's T009/T010 if parallel)
- **US3 (Phase 4)**: after Setup; T015 → T016 → T017 (one suite, sequential) → T018 → T019;
  reports collectors untouched (imports only)
- **US4 (Phase 5)**: **after US1–US3** (spec FR-019: orchestration lands last, needs stable
  definitions — wave 5); (T020 ∥ T021) → T022 → T023 → (T024 ∥ T025) → T026
- **Polish (Phase 6)**: after completed stories (T029/T030 cover the shipped slices;
  T027/T028 are the full gates)

### User Story Dependencies

- **US1 (P1)**: no story dependencies — MVP; uses only Setup output + existing E0 runtime
- **US2 (P2)**: Setup only; shares two source files with US1 (serialize edits if staffing
  both in parallel)
- **US3 (P3)**: Setup only; its pure-function tests (T015–T016) need no other story
- **US4 (P4)**: depends on US1–US3 registered definitions (the start tool's enum lists them;
  E2E drives a US1 workflow) — spec FR-019 records this as the wave-5 landing order

### Within Each User Story

- Tests fail first, then paired implementation turns them green (P43)
- Content/helpers (`autopilotWorkflowContent.ts`) before definitions
  (`autopilotWorkflows.ts`) — the established split
- Workflow defs register through the existing seam; executor/firewall/budgets untouched
  (re-verified at each checkpoint via the untouched-green suites)

### Parallel Opportunities

- Setup tests: T001 ∥ T002 ∥ T003 (distinct files); then T004 ∥ T005 ∥ T006 (distinct files)
- US1: T007 → T008 (same suite, sequential) → T009 → T010
- US2: T011 → T012 (same suite, sequential) → T013 → T014
- US3: T015 → T016 → T017 (same suite, sequential) → T018 → T019
- US4 tests: T020 ∥ T021 (distinct files); implementation: T022 → T023 → (T024 ∥ T025
  distinct files) → T026
- Polish: T027 → T028; then T029 ∥ T030
- Cross-story: US1/US2/US3 suites are in distinct files once their shared source-file edits
  are serialized; US4 starts only after all three land

## Parallel Example: User Story 4

```text
# Launch US4 test tasks together (distinct files, all fail first):
Task: "autopilot-run-tools.test.ts — five defs, allowlist, scoping, trigger provenance"
Task: "samChatTools.test.ts — ToolSet membership, projectId injection, FRESH_READ, caching"

# Then implementation:
Task: "autopilot-run-tools.ts — five MCP-shaped definitions (no route registration)"
Task: "samChatTools.ts — adapt five tools + FRESH_READ_TOOLS entries"
# Then in parallel (distinct files):
Task: "e2e/sam-autopilot.spec.ts — picker + start→poll→cancel→resume lifecycle"
Task: "autopilotEvidence.test.ts — facts/recommendations, sections, status chips"
# Finally:
Task: "autopilotEvidence.ts renderers + SamAutopilotTab evidence wiring"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001–T006) — allowlist + language bans green
2. Phase 2 (T007–T010) — content_refresh end-to-end
3. **STOP and VALIDATE**: quickstart V1 + V2; demo a content-refresh run from the SAM
   Autopilot tab (picker already shows the new type)

### Incremental Delivery

1. Setup → US1 (MVP) → validate V1/V2
2. US2 (technical-SEO) → validate V2 → demo the coverage-state honesty
3. US3 (monthly-review) → validate V2 (SC-006/SC-008 fixtures) → demo a two-window review
4. US4 (SAM tools + client renderers + E2E) → validate V4 + V6 → demo chat start/poll/resume
5. Polish/gates (T027–T030) → merge

### Notes

- US1/US2/US3 are PR17+PR18 slices; US4 is PR21 — the spec's FR-019 wave order is encoded in
  the phase dependencies (orchestration last)
- The two-file hot zone is `autopilotWorkflowContent.ts` + `autopilotWorkflows.ts`: US1–US3
  each append; serialize those edits if stories run in parallel
- Any discovered need beyond scope (public MCP run-starters, cadenced autopilot runs, LLM
  synthesis, E1d competitor-gap) is OUT — raise to plan gates, never grow the slice
  silently (P50)