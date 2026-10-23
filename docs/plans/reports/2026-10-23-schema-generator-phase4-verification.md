# Phase 4 - Schema Generator Verification (spec 016)

Date: 2026-10-23
Branch: `feat/p1-schema-generator`
Base: `17091a54` (crawler milestone HEAD)
Commits: `ac8bd94b`, `453fd9c4`, `aa956c9a`, `3d37312d`, `16a5f824`, `e4a54ee0`, `9a3490bd`, `2314446b`, `6c2ac0a9`, `4e7e2f84`

## A. Repository Assessment

- Reused the crawler milestone's persisted page evidence (`extraction_state`,
  `page_type`, parsed JSON-LD, headings, images, canonical, Salla product/blog
  fields) instead of adding a second crawler or parser.
- Followed the existing server function -> service -> repository layering,
  project-scoped authorization middleware, MCP tool registration/overflow
  pattern, audit issue descriptor/gating model, and the audit modal/download
  UI helpers.
- Confirmed gaps: no live-store validation (fixtures only); no persisted
  schema proposals (generation is read-only and deterministic).

## B. Implementation Status

| Deliverable                              | Status   | Evidence                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed-only generator (12 types)       | COMPLETE | `src/server/lib/schema/{types,observations,generate}.ts`; STATIC_COMPLETE only; properties without observed values are omitted; Product `offers` omitted without observed price; Organization/LocalBusiness/Person/Event/Service/FAQPage normalize only from an existing observed node of the same type, otherwise refuse with reasons |
| Two-axis validation                      | COMPLETE | `validate.ts` reports validity and Google rich-result eligibility separately, including `missingRichResultRequired`; reasons never silently resolve conflicts                                                                                                                                                                          |
| Existing-vs-proposed diff                | COMPLETE | `diff.ts` emits `kept`, `added`, `changed`, `conflicting`, `existing_only`; absent values serialize as `null` via `toSchemaJson`                                                                                                                                                                                                       |
| `schema_gap` detector                    | COMPLETE | `gap-detector.ts` wired into `page-reporters.ts`, gated to STATIC_COMPLETE pages                                                                                                                                                                                                                                                       |
| Project-scoped service + server function | COMPLETE | `SchemaService.getPageSchema`, `AuditRepository.getAuditPageForProject`, `getAuditPageSchema` + Zod input; authorization covered                                                                                                                                                                                                       |
| MCP tool                                 | COMPLETE | Read-only `get_page_schema` (`src/server/mcp/tools/get-page-schema.ts`), registered via the overflow registrar; 4 tests                                                                                                                                                                                                                |
| Editor UI (preview/copy/export)          | COMPLETE | `SchemaEditorModal` opened from the audit pages table; type availability with refusal reasons, validation badges, diff table, review confirmation gate only for `changed`/`conflicting`, JSON preview, clipboard copy, JSON-LD download                                                                                                |
| E2E                                      | COMPLETE | `e2e/audit-schema-editor.spec.ts` + `e2e/fixtures/audit-schema-fixtures.ts`, gated by `VITE_E2E_AUDIT_FIXTURES`                                                                                                                                                                                                                        |
| Fabrication-guard tests                  | COMPLETE | Generator/validator/diff/gap suites cover omitted values, unknown availability, missing price, and refusal paths                                                                                                                                                                                                                       |

## C. Crawler Verification

Not applicable; Phases 1-3 remain unchanged at `17091a54` and are covered by
`docs/plans/reports/2026-10-23-crawler-milestone-verification.md`.

## D. Feature Verification

- Observed-only policy: every emitted property maps to a page field or a parsed
  JSON-LD/microdata/stored extraction source; `price`, `priceCurrency`,
  `availability`, ratings, reviews, addresses, and authors are never invented.
- Refusal: non-STATIC_COMPLETE pages, unsupported types, and types without an
  existing same-type node return explicit reasons; the UI disables unavailable
  types and explains why.
- Confirmation: the UI requires an explicit review checkbox before copy/export
  when the diff contains `changed` or `conflicting` properties; added-only
  proposals export directly.
- Read-only: no schema is persisted or written to the audited page; MCP and the
  editor only return proposals.
- Authorization: `getAuditPageSchema` rejects audits/pages outside the caller's
  project, and the MCP tool enforces project auth (authorization suite 9/9).

## E. Test Results

- `pnpm exec vitest run --reporter=dot`: 333/334 files passed; 3266 passed,
  3 skipped, 1 failed. The sole failure is
  `src/server/features/rank-tracking/services/livePausedAccountCheck.test.ts:48`
  (`expected undefined to be defined`), a live DataForSEO API test whose
  `loadLocalEnv()` reads `.env.local`/`.env` (absent in this worktree); it is
  unrelated to schema changes and `.dev.vars` does contain the key.
- `pnpm exec tsc --noEmit --pretty false`: clean.
- `pnpm exec prettier --check` on all changed files: clean.
- `pnpm exec oxlint --type-aware --deny-warnings` on changed files: 0 warnings,
  0 errors.
- `pnpm exec knip`: no schema-related findings after removing three unused
  exports (`existingSchemaTypes`, `GetPageSchemaInput` export, `SchemaEditorPage`
  export).
- `pnpm exec playwright test e2e/audit-schema-editor.spec.ts`: 2/2 passed
  (product changed-price flow with confirmation/copy/export; blog added-only
  flow without confirmation).
- `pnpm build`: passes after `4e7e2f84` (client + SSR + `tsc`). The gate was
  red at base `17091a54`: `SamChatAgent` statically imports `samLongRunningTools`
  -> `site-audit-tools`, and `agents@0.17.3`'s Agent base class statically
  imports the MCP client. The fix lazy-loads `get_audit_status` on the first
  poll and narrows the SDK guard to the server implementation (the client and
  its three shared helpers are intrinsic to the statically exported chat DOs).
  `tsc --noEmit` was also verified independently (exit 0), and the affected SAM
  suites pass (22/22).

## F. Cost & Security Review

- No new paid providers, API keys, or background jobs.
- Generation reads persisted audit evidence only; no outbound fetch.
- Project scoping is enforced in the server function and MCP tool; no schema
  data is exposed cross-project.
- No secrets or credentials were added; E2E fixtures are synthetic.

## G. Remaining Risks & Next Steps

1. Re-run the eager-boundary guard after any `agents`/`@cloudflare/think`
   upgrade: the SDK client is now allowed because the Agent base class needs
   it, but a new eager server-side SDK path should still fail the build.
2. Regenerate the missing Drizzle snapshots (`0066`-`0068`, `0044`-`0046`)
   before the next schema change.
3. Live-store validation remains pending (fixture-only acceptance basis).
4. Types without a persisted same-type node are intentionally refused; broaden
   observation sources only with real evidence, never defaults.
