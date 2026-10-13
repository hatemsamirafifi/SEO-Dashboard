# Contract: competitor_gap Autopilot Workflow (Part C — conditional on Part B)

**Status**: Conditional. Ships only after Part B produces opportunities and a recorded READY verdict. Orchestration over frozen evidence only (P34); never a source of competitor-gap facts.

## Workflow identity

- `workflowType`: `"competitor_gap"` — added to `AUTOPILOT_WORKFLOW_TYPES` (`src/shared/autopilot.ts`) in the same PR as the workflow implementation; existing structural-exclusion test (`autopilot.test.ts`, G5/P36 guard) updated in that PR.
- Labels/descriptions added to `AUTOPILOT_WORKFLOW_LABELS` / `AUTOPILOT_WORKFLOW_DESCRIPTIONS` (observational language, no uplift promises).

## Execution contract

- Consumes stored competitor-gap findings/opportunities via existing services (FindingService/OpportunityService); `sourceEvidenceRef` pins the frozen findings snapshot the run operates over.
- Step kinds limited to `collect` / `correlate` / `synthesize` (no autonomous external side effects; `side_effect` not used).
- Bounded: workflow allowlisted, step/tool-call budgets enforced via `autopilotBudgets.ts` and step executor guards; resumable attempts; durable step history; idempotent re-entry (P35).
- Zero run-time paid provider calls: all inputs arrive as stored evidence (G10 analog for autopilot; SC-006).

## Output language (synthesisFirewall gates)

- Output passes `synthesisFirewall.ts` review gates: no causal verbs, no invented rankings/gaps/uplift, observed-fact vs recommendation split (P27/P46).
- When inputs are absent (no READY findings, coverage gaps): the workflow reports "no stored competitor-gap opportunities" as an explicit empty state — never inferred from input failure.

## Failure semantics

- Resume after mid-run failure replays from the step ledger; terminal states never double-emit summaries.
- Workflow failure never fabricates gaps; failed runs surface as failed with reason — they do not produce "no gaps" output.

## Test matrix (mandatory)

- E2E: start → poll → resume completes over frozen-evidence fixtures with 0 paid calls (SC-006).
- Language review: sampled outputs pass firewall gates (no causal claims, no invented metrics).
- Idempotency: re-run over the same pinned evidence yields same outputs / no duplicate side effects.
- Gate: workflow type absent from allowlist before READY PR; boundary test updated in same PR.
