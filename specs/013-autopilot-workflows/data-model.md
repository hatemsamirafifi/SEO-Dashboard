# Data Model: Autopilot Workflows + SAM Orchestration (013)

**Phase 1 output.** This package adds **no database schema, no migrations, no new tables**
(source plan §10: "E workflow definitions — no new schema required"; verified against the live
schemas). The existing durable triples absorb the feature as data:

## 1. Existing entities (unchanged shapes, new values)

### autopilot_runs (`src/db/autopilot.schema.ts` + `src/db/pg/autopilot.schema.ts`)

| Field | Existing semantics | New values from this feature |
| --- | --- | --- |
| `workflowType` (text) | registered workflow identity | + `content_refresh`, `technical_seo`, `monthly_review` |
| `trigger` (text) | who started it (`manual` default) | + `sam_chat` (≤ 40 chars; written by the start tool, ≤ 40 fits existing column) |
| `status` | `pending \| running \| completed \| failed \| cancelled` | unchanged |
| `errorClass` (text, nullable) | failure classification | unchanged (executor's classes) |
| other fields | run identity, scoping, timestamps, `currentAttemptId`, `evidenceHash` | unchanged |

Validation rules: `workflowType` must be a member of `AUTOPILOT_WORKFLOW_TYPES`
(`src/shared/autopilot.ts`) at every trust boundary (server-function Zod schema, SAM tool
schema, service registry check); `trigger` is a bounded free string ≤ 40.

### autopilot_attempts + autopilot_steps

Unchanged shapes. Attempts pin source versions (`versions`/`sourceSet`/`detectorVersions`/
`thresholdVersion` hashed — `AttemptPin`); steps carry `seq` (dense 0-based), `kind`
(`collect | correlate | transform | synthesize | side_effect`), `name`, `status`,
`evidenceJson` (frozen), `evidenceHash`, `toolCalls`, `idempotencyKey` (required for
`side_effect` — none of the new workflows use `side_effect` steps).

## 2. New frozen-evidence payloads (JSON in `evidenceJson` — contract-pinned, not schema)

The shapes below are the frozen evidence the new workflows write per step. They are plain
JSON-serializable objects (the executor requires serialization success); field-level rules are
contracts, enforced by workflow tests, not DB constraints.

### 2.1 content_refresh — collect (seq 0)

```text
{
  opportunities: CollectedOpportunity[],   // existing shape (autopilotWorkflowContent.ts):
                                          // id, logicalKey, type, priority(Critical|High|Medium|Low),
                                          // impactScore(0-100), confidenceScore(0-100), title,
                                          // page, keyword, lastDetectedAt
  insights: CollectedInsight[],            // existing shape: insightKey, severity, title
  collectedAt: ISO-8601
}
```

### 2.2 content_refresh — correlate (seq 1)

```text
{
  rankedIds: string[],        // ≤ 10 opportunity ids, deterministic order:
                              // priority (Critical>High>Medium>Low) → impactScore desc →
                              // confidenceScore desc → id
  totalConsidered: number
}
```

### 2.3 content_refresh — synthesize (seq 2)

```text
{
  recommendations: Recommendation[],  // serializer output shape (autopilotSerializer.ts):
                                      // evidenceType: "observational", expectedImpact:
                                      // { kind: "qualitative" } ONLY (never "quantified" —
                                      // no basis exists; R2), confidence { value, why }
  evidenceType: "observational",
  promptVersion: 1
}
```

### 2.4 technical_seo — collect (seq 0)

```text
{
  auditCoverage:
    | { state: "never_run" }
    | { state: "stale_or_failed", auditStatus: string }
    | { state: "empty_crawl" }
    | { state: "ready", auditId: string, pagesCrawled: number, completedAt: ISO-8601 | null },
  issues: Array<{ severity: "critical"|"warning"|"info", type: string, count: number }>,
          // aggregated from getIssueTypePageCountsForAudit (the dashboard's stored
          // surface); audit issue vocabulary is critical/warning/info per the
          // auditIssues schema — never remapped. Empty array iff state ≠ ready
  ...engineState                            // opportunities + insights + collectedAt (§2.1)
}
```

Coverage state machine (R3): no audit row → `never_run`; latest audit not terminal-success →
`stale_or_failed`; terminal with `pagesCrawled = 0` → `empty_crawl`; otherwise `ready`.
Synthesis over any non-`ready` state emits the insufficient-coverage block and no issue plan
(never "no issues").

### 2.5 technical_seo — correlate (seq 1)

```text
{
  rankedIssues: Array<{ severity, type, count }>,   // severity order: critical>high>medium>info
                                                    // (SEVERITY_ORDER), then count desc; ≤ 10
  rankedOpportunityIds: string[],                    // technical-type opportunities, §2.2 order; ≤ 10
  auditCoverage: (echoed verbatim)
}
```

### 2.6 technical_seo — synthesize (seq 2)

```text
{
  facts: { auditCoverage, rankedIssues },            // what happened (P27)
  recommendations: Recommendation[],                 // what OpenSEO suggests; qualitative impacts
  evidenceType: "observational",
  promptVersion: 1
}
```

### 2.7 monthly_review — collect (seq 0)

```text
{
  month:    { from: "YYYY-MM-01", to: "YYYY-MM-DD" },   // previous complete UTC month
  prior:    { from: "YYYY-MM-01", to: "YYYY-MM-DD" },   // the month before it
  searchVisibility:  { month: <envelope>, prior: <envelope> },
  trafficConversions: { month: <envelope>, prior: <envelope> },
  overviewParts: { rank, technical, backlinks },   // latest-state envelopes (not windowed)
  engineState,                                    // open opportunities + unresolved insights
  collectedAt: ISO-8601
}
```

`<envelope>` = the collectors' return shapes **verbatim** (`reportSections.ts`):
`{ status: READY, totals… }` or `{ status: unavailable("not_connected" | "no_coverage" |
"provider_failed" | "no_data"), totals: null }`. Envelopes are never coerced (P8/P9/G9).

### 2.8 monthly_review — correlate (seq 1)

```text
{
  month: { from: "YYYY-MM-01", to: "YYYY-MM-DD" },   // echoed windows (period basis)
  prior: { from: "YYYY-MM-01", to: "YYYY-MM-DD" },
  changed: Array<{
      source: "gsc" | "ga4",
      metric: string,                    // clicks | impressions | sessions | pageViews |
                                         // keyEvents | transactions (additive only)
      monthValue: number | null,
      priorValue: number | null,
      delta: number | null,              // null unless BOTH windows READY — never a fake zero-delta
      agreement: "corroborated" | "single_source"   // single_source → provisional in output
    }>,
  ratios: Array<{ metric: "ctr" | "position", monthValue, priorValue }>,
                                          // side-by-side only, NEVER differenced (P23)
  unavailable: Array<{ source: string, reason: string }>,   // every non-READY envelope, listed
  unresolved: Array<{ kind: "opportunity" | "insight", priority, title }>,   // Critical/High only
  totalConsidered: number
}
```

### 2.9 monthly_review — synthesize (seq 2)

```text
{
  summary: {
    changed: ChangedRow[],               // §2.8 rows, single_source rows tagged provisional
    ratios: RatioRow[],                   // side-by-side only (P23) — passed through verbatim
    unavailable: UnavailableRow[],        // every non-READY source, passed through (G9)
    unresolved: UnresolvedRow[],
    nextActions: Recommendation[]         // one per top unresolved item, citing source rows
  },
  evidenceType: "observational",
  promptVersion: 1
}
```

## 3. Entity relationships

```text
autopilot_run (workflowType: content_refresh | technical_seo | monthly_review, trigger: sam_chat?)
 └── autopilot_attempt (pin = source versions at start; ≤ 3 per run)
      └── autopilot_step (seq 0..2, frozen evidenceJson per §2)
```

No new relationships: evidence payloads reference stored rows by id/logicalKey only
(opportunity ids, audit id) — never raw external payloads, never cross-project data
(collectors and repositories are all project-scoped, P39).

## 4. Validation rules summary (trust boundaries)

| Boundary | Rule |
| --- | --- |
| Server fn / SAM tool input | `workflowType` ∈ `AUTOPILOT_WORKFLOW_TYPES` (Zod enum); `runId` non-empty; `trigger` ≤ 40 |
| Service registry | unknown workflowType → `VALIDATION_ERROR`, no run row (existing behavior) |
| Step evidence | must JSON-serialize (executor requirement); serializer enforces observational safety + qualitative-only impacts |
| Collect output | collector envelopes verbatim — `null` stays `null`, unavailable stays unavailable (G9) |

## 5. Parity statement

D1 + PG schemas are untouched (no migration); `schema-parity.test.ts` stays green by no-op
(P3–P5). The only at-rest change is new text values in existing columns.