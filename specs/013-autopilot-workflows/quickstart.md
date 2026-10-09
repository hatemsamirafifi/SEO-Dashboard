# Quickstart: Autopilot Workflows + SAM Orchestration (013)

**Phase 1 output — runnable validation scenarios.** Proves the feature end-to-end per
quickstart conventions. Implementation details live in tasks.md (Phase 2). All commands run
from repository root. Preconditions: `pnpm install` done; `pnpm types:check` +
`pnpm oxlint` green on `main`.

## V0 — Prerequisites check

1. `pnpm exec vitest run src/server/features/autopilot src/server/mcp/tools/report-autopilot-tools.test.ts`
   — existing autopilot + MCP tool suites green (the E0 base this feature extends).
2. Confirm no autopilot migration diff: `git status -- src/db/ src/drizzle/` shows nothing
   (this package is schema-free — data-model §5).
3. `pnpm exec vitest run src/db/schema-parity.test.ts` — parity green by no-op.

**Expected**: all green; if V0.2 shows a schema diff, stop — something outside this feature
changed the DB layer (P48).

## V1 — Allowlist + registration (R1, workflow-definitions §1)

1. `pnpm exec vitest run src/shared src/types/schemas` — new workflow-type enum cases pass:
   `content_refresh` / `technical_seo` / `monthly_review` valid; `competitor_gap`, arbitrary
   strings rejected by `startAutopilotRunSchema`.
2. `pnpm exec vitest run src/server/features/autopilot/services/autopilotWorkflows.test.ts`
   — six workflows register (no duplicates); labels/descriptions have exactly one entry per
   type; each new def: dense 0-based seqs, collect/correlate/synthesize kinds, no
   side-effect steps.

**Expected**: enum + registration + shape assertions green (SC-004 at the schema layer).

## V2 — Workflow evidence & language invariants (SC-001/SC-002/SC-006)

1. `pnpm exec vitest run src/server/features/autopilot/services/autopilotSerializer.test.ts`
   — causal-verb ban + uplift-pattern ban (`/\d+\s*%/`) + qualitative-only impacts hold for
   the three new outputs.
2. `pnpm exec vitest run src/server/features/autopilot/services/autopilotWorkflows.test.ts`
   — per-workflow fixtures:
   - content-refresh: ranked candidates ≤ 10 in priority→impact→confidence→id order;
   - technical-SEO: `auditCoverage` state machine — `never_run` fixture →
     insufficient-coverage block, zero issue-plan recommendations, run completes;
     `stale_or_failed`/`empty_crawl` fixtures → same honest path; `ready` fixture →
     ranked issues (severity order) + facts/recommendations separation;
   - monthly-review: two-window fixtures — both-READY → delta row; one-window-unavailable →
     unavailable row (never zero-delta); ctr/position appear side-by-side, never
     differenced; `single_source` → provisional tag; empty project → honest
     nothing-to-review output (empty ≠ failure).

**Expected**: every fixture passes; zero causal/uplift violations (SC-001); frozen evidence
is JSON-serializable and version-pinned (SC-002).

## V3 — Pin/firewall integration (SC-002)

1. `pnpm exec vitest run src/server/features/autopilot/services/stepExecutor.test.ts
   src/server/features/autopilot/services/AutopilotServiceDrive.test.ts`
   — existing executor suites green with the new definitions registered (drive completes,
   budgets enforce, invalidation retries).
2. Cross-attempt synthesis rejection: existing `synthesisFirewall` behavior re-verified with a
   monthly-review attempt fixture — mixed-version synthesis throws.

**Expected**: E0 invariants hold unchanged for new workflows (extends, not forks).

## V4 — SAM tool surface (SC-004 + tool adapter rules)

1. `pnpm exec vitest run src/server/mcp/tools/autopilot-run-tools.test.ts` — allowlisted
   start passes `trigger: "sam_chat"`; non-allowlisted type rejected pre-handler; wrong-project
   runId → `NOT_FOUND`; output shapes per contracts/sam-autopilot-tools.md §1.
2. `pnpm exec vitest run src/server/features/sam/samChatTools.test.ts` — the five tools are
   in the ToolSet; `projectId` absent from model-facing schemas (injected server-side);
   `get_autopilot_run`/`list_autopilot_runs` bypass the dedup cache (fresh-read); cancel on a
   completed run returns the terminal status idempotently.
3. `pnpm exec vitest run src/serverFunctions/autopilot.authorization.test.ts` — existing UI
   auth matrix still green (untouched, regression-free).
4. `git diff -- src/server/mcp/server.ts` — empty (public route unchanged).

**Expected**: tool adapter behaviors green; zero public-route registrations.

## V5 — Client evidence rendering

1. `pnpm exec vitest run src/client/features/sam/autopilotEvidence.test.ts` — new renderers:
   technical-SEO facts/recommendations separated; monthly-review changed/unresolved/next-actions
   sections with status chips for unavailable reasons; single-source provisional tags.
2. `pnpm exec vitest run src/client/features/sam` — SamAutopilotTab picker renders all six
   types from the shared const.

**Expected**: picker + renderers green without structural tab changes.

## V6 — E2E lifecycle (SC-003)

1. `pnpm exec playwright test e2e/sam-autopilot.spec.ts`
   — SAM Autopilot tab: picker shows six workflows; start a `content_refresh` run → poll
   shows live step checklist → terminal state renders evidence; cancel an active run →
   status flips truthfully; resume a cancelled run → run continues to completion.

**Expected**: start → poll → cancel → resume lifecycle round-trips through the durable run
record in 100% of runs (SC-003).

## V7 — Full gates (P45)

1. `pnpm types:check`
2. `pnpm oxlint`
3. `pnpm exec vitest run src/server/features/autopilot src/server/features/sam src/server/mcp/tools src/shared/autopilot.test.ts src/client/features/sam src/db/schema-parity.test.ts`
   (plus the new suites by path).
4. Re-run V0 — the E0 base remains green (no regressions to the three existing workflows).

**Expected**: all gates green; feature declarable READY per Constitution Appendix C.

## Validation summary

| Scenario | Proves | Ver |
| --- | --- | --- |
| Schema rejects non-allowlisted types; registry fail-closed | FR-011, SC-004 | V1 |
| Coverage state machine; no invented "no issues" | FR-004/005, SC-006 | V2 |
| Two-window honesty; zero-delta never fabricated; provisional tags | FR-007/008 | V2 |
| Causal/uplift bans over all new outputs | FR-002, SC-001 | V2 |
| Executor/firewall/pin invariants hold for new defs | FR-003/016, SC-002 | V3 |
| Five tools: scoping, allowlist, fresh-read, provenance, no public route | FR-010–015 | V4 |
| Evidence renderers + six-type picker | FR (UI slices), V5 expectations | V5 |
| Full lifecycle through durable record | SC-003 | V6 |
| Gates + no regression on E0/parity | P43–P45 | V7 |