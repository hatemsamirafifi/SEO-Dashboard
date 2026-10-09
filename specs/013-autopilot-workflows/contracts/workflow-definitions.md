# Contract: Workflow Definitions + Allowlist (E1a/E1b/E1c)

**Feature 013 · Phase 1 contract.** Governs the three new autopilot workflows, their frozen
evidence shapes (detail in [data-model.md](../data-model.md) §2), and the single allowlist.
All definitions register through `registerAutopilotWorkflow` (existing seam,
`autopilotTypes.ts`); the executor, budgets, pin machinery, and synthesis firewall are
consumed unchanged.

## 1. The allowlist (R1)

`AUTOPILOT_WORKFLOW_TYPES` (`src/shared/autopilot.ts`) is the single, exhaustive, ordered list:

```text
growth_plan · quick_wins · traffic_drop · content_refresh · technical_seo · monthly_review
```

Rules:

1. Every trust boundary that accepts a workflow type validates against this list (Zod enum):
   `src/types/schemas/autopilot.ts` (`startAutopilotRunSchema`) and the SAM tool schemas.
2. `AUTOPILOT_WORKFLOW_LABELS` / `AUTOPILOT_WORKFLOW_DESCRIPTIONS` must have exactly one entry
   per type (TS enforces; tests re-assert).
3. `AutopilotService.startAutopilotRun` keeps the registry fail-closed check
   (`getAutopilotWorkflow(type) ?? throw VALIDATION_ERROR`) — const membership without
   registration, or registration without const membership, can never start a run.
4. Competitor-gap (`E1d`) is structurally excluded: not in the const, not registered (G5/P36).

## 2. Workflow shapes (all three follow the existing three-step pattern)

| Workflow | Type | Steps | Collects (stored only) |
| --- | --- | --- | --- |
| Content refresh (E1a) | `content_refresh` | collect → correlate → synthesize | engine state (opportunities + insights) via existing `collectEngineState` |
| Technical SEO (E1b) | `technical_seo` | collect → correlate → synthesize | latest audit + issues (`AuditRepository.getLatestAuditForProject` / `getIssuesForAudit`) + engine state |
| Monthly review (E1c) | `monthly_review` | collect → correlate → synthesize | two-window reports collectors (`reportSections.ts`) + latest-state overview parts + engine state |

Common step rules (inherited contracts — re-asserted by tests):

- seq is dense 0-based; kinds ∈ `collect | correlate | synthesize` (no `side_effect` steps —
  these workflows are read-only over stored data);
- collect steps dual-gate against the attempt pin (`runCollectStep` → invalidate on mismatch);
- synthesize evidence passes `serializeRecommendations` + `assertObservationalSafe`
  (`evidenceType: "observational"`), records `toolCalls: 1`, `promptVersion: 1`;
- synthesize may only consume prior-step frozen evidence from the same attempt
  (`assertSynthesisInput` — existing firewall, no changes);
- every recommendation's expected impact is `{ kind: "qualitative" }` — never `quantified`
  (no evidence basis exists for uplift; R2). Output must match zero causal-verb hits and zero
  `/\d+\s*%/` uplift hits (SC-001);
- impactScore and confidenceScore stay separate fields end-to-end (P26).

## 3. Per-workflow contracts

### 3.1 content_refresh

- Collect: engine state only; collectedAt recorded.
- Correlate: rank refresh candidates (stored priority → impact → confidence → id), ≤ 10,
  from page-related opportunity types (content-decay/ranking-drop families and any
  `page`-bearing priority rows); `totalConsidered` = filtered candidate count.
- Synthesize: one recommendation per ranked candidate, each citing its metrics and periods
  from frozen evidence; observational phrasing ("decreased during the same period",
  "consistent with") — prompt contract added to `WORKFLOW_PROMPTS`.

### 3.2 technical_seo

- Collect: `auditCoverage` state machine — `never_run` | `stale_or_failed(auditStatus)` |
  `empty_crawl` | `ready(auditId, pagesCrawled, completedAt)` (R3); issues aggregated by
  severity+type with counts; engine state included.
- Correlate: `rankedIssues` (severity order `critical>warning>info` (audit schema vocabulary — P48: repo wins), then count desc, ≤ 10)
  **and** `rankedOpportunityIds` (technical opportunities, §2.2 order, ≤ 10); coverage echoed.
- Synthesize: `facts` (coverage + ranked issues) separated from `recommendations` (P27).
  Non-`ready` coverage → exactly one insufficient-coverage recommendation ("audit coverage
  missing/stale — run a site audit first"), zero issue-plan recommendations, run still
  completes (honest absence ≠ failure, P28/P21).

### 3.3 monthly_review

- Windows: `month` = previous complete UTC calendar month, `prior` = the one before it
  (deterministic derivation, pure function in `autopilotWorkflowContent.ts`; late starts
  still review complete months — never partial current months) (R4).
- Collect: `collectSearchVisibility` + `collectTrafficAndConversions` for **both** windows;
  `collectOverviewParts` (latest-state: rank/technical/backlinks); `collectInsights` +
  `collectOpportunities`. Envelopes frozen verbatim.
- Correlate: `changed` rows only where both windows are READY (additive metrics only:
  clicks, impressions, sessions, pageViews, keyEvents, transactions); `ratios` (ctr, position,
  engagement) side-by-side, never differenced (P23); every non-READY envelope listed in
  `unavailable` with reason; `agreement` = `corroborated` | `single_source` (existing
  vocabulary); `unresolved` = Critical/High open opportunities + unresolved insights.
- Synthesize: `summary.changed` (single-source rows tagged provisional), `summary.unresolved`,
  `summary.nextActions` (one recommendation per top unresolved item, citing source rows).
  No zero-delta fabrication: an unavailable window yields an unavailable row, not a 0-change
  (G9).

## 4. Synthesis language rules (all workflows)

- Banned in `observational` output (existing `BANNED_CAUSAL`, re-tested for new outputs):
  caused/causes/causing/because of/due to/led to/resulted in/triggered.
- Banned everywhere in new outputs: uplift percentage patterns (`/\d+\s*%/`), quantified
  expected impacts.
- Required: metrics + periods cited; provisional marking for single-source claims;
  impact/confidence separate (P26, P46).

## 5. Pin coverage (R6)

No new source-version inputs. All new evidence sources (gsc, ga4, rank, audit, backlinks,
engine) are already pin inputs via `assembleDetectionSourceState`. Mid-run source changes →
attempt invalidated → bounded retry per existing executor rules. Known accepted nuance (same as
existing workflows): opportunity lifecycle edits (in_progress/completed) do not advance
versions; `collectedAt` in frozen evidence keeps staleness visible (P46).

## 6. Registration and exports

- `autopilotWorkflowContent.ts`: + `WORKFLOW_PROMPTS` entries (three), + pure helpers
  (month-window derivation, audit-coverage reducer, issue aggregation, changed-row builder,
  technical/content recommendation builders).
- `autopilotWorkflows.ts`: + three `*Def()` factories added to
  `ensureAutopilotWorkflowsRegistered()`'s list; `collectEngineState` reused; a new exported
  `collectAuditEvidence(projectId)` and `collectMonthlyEvidence(projectId, organizationId)`
  (thin wrappers over the repository/collector reads) so each workflow def stays declarative.
- `src/shared/autopilot.ts`: + three types, + labels/descriptions.

## 7. Acceptance mapping

| Spec FR | Contract clause |
| --- | --- |
| FR-001–003 | §2 common rules, §3.1, §4 |
| FR-004–006 | §3.2 (coverage semantics, facts/recommendations, no side-effect steps) |
| FR-007–009 | §3.3 (windows, envelopes, frozen evidence), §5 |
| FR-016 (extends existing runtime) | §1, §6 |
| SC-001/SC-002/SC-005/SC-006/SC-008 | §4, §3.2, §3.3 |