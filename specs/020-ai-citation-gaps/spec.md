# Feature Specification: AI Citation Gaps

**Feature Branch**: `feat/p1-ai-citation-gaps`
**Created**: 2026-10-24
**Status**: Implemented - Phase 8 delivered 2026-10-25: the Prompt Explorer records every fresh model answer as two new dual-dialect tables (`ai_search_runs`, `ai_search_citations`, migrations 0071/0049) with hashes and counts only (prompt and answer text are never persisted; deterministic run/citation ids and unique indexes make repeat observations idempotent), isolated via `waitUntil` so a failed write never changes the paid answer; an `ai_citation_gap` detector reads the stored observations through a dedicated `ai_search` source version, emits the three finding families (cited without us, frequently cited third party, no cited sources) with observed counts and injected small-sample labels through the existing materializer path, and a read-only `get_ai_citation_gaps` MCP tool returns the materialized gaps for the authorized project. Unit suites, schema parity, `tsc`, oxlint, and knip show no new findings; the full suite has one pre-existing env-gated live-API failure; `pnpm build` is green (see `docs/plans/reports/2026-10-25-ai-citation-gaps-phase8-verification.md`).
**Input**: User description: "Phase 8 of the P1 SEO Intelligence master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` section 3.2 row 8): `ai_search_runs` + `ai_search_citations` tables (provider/model/prompt/tokens/fan-outs, content-hash event keys, privacy-preserving); mention-vs-citation separation reusing `extractCitations`; gap detector (competitor-cited-where-we're-not, frequently-cited third parties, topic gaps); dashboard surfaces + filters; MCP reads; small-sample uncertainty labels; budgets/privacy preserved."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Keep the observed AI citations without keeping the prompt (Priority: P1)

When the Prompt Explorer asks a question, the run is recorded with the provider,
the model, the observed token count, the fan-out count, and the pages the model
cited. The prompt itself is never stored: the run keeps a hash of the prompt and
a content hash of the answer, so the same observation is never counted twice and
the stored rows cannot be read back as the user's text.

**Why this priority**: The gap analysis needs history; storing raw prompts would
turn an analytics table into a copy of whatever the user typed.

**Independent Test**: Run the Prompt Explorer against a stubbed provider, assert
one run row and one row per citation, assert the run row holds a prompt hash and
no prompt text, and assert a failing write leaves the explorer working.

**Acceptance Scenarios**:

1. **Given** a successful model answer with citations, **When** the run is
   recorded, **Then** one run row and one citation row per cited URL exist, with
   the model, provider, token count, and fan-out count.
2. **Given** the same prompt answered with the same answer again, **When** the run
   is recorded, **Then** the content-hash event key matches the earlier run and
   no duplicate rows are written.
3. **Given** a failed write, **When** the explorer returns, **Then** the answer
   still renders and the failure is reported on its own.

### User Story 2 - See where the AI answers cite others and not us (Priority: P1)

A project owner sees, for the recorded runs, the questions where the models
cited other sites but not this project, the third-party domains that keep being
cited, and the questions that produced no citations at all. Every finding states
the observed counts and how many runs it is based on.

**Why this priority**: "The AI answers cite a competitor and not us" is the
actionable version of AI visibility.

**Independent Test**: Seed runs with citations (some ours, some not) and assert
the three findings, the observed counts, and the small-sample label when too few
runs exist.

**Acceptance Scenarios**:

1. **Given** a run whose citations are all third-party domains, **When** the gap
   analysis runs, **Then** a "cited without us" finding names the run and the
   cited domains.
2. **Given** a domain cited in three or more runs, **When** the gap analysis
   runs, **Then** a "frequently cited third party" finding names the domain and
   the run count.
3. **Given** a run with no citations at all, **When** the gap analysis runs,
   **Then** a "no cited sources" finding names the run.
4. **Given** fewer runs than the confidence floor, **When** a finding is emitted,
   **Then** it is labelled as a small sample and carries a lower confidence.

### User Story 3 - Read the gaps from the product and from tools (Priority: P2)

The findings appear in the existing opportunities list with their own type, and a
read-only MCP tool returns them for assistants working in the project.

**Why this priority**: The rest of the wave's findings are reachable the same
way, so the AI gaps must be reachable too.

**Acceptance Scenarios**:

1. **Given** a recorded AI citation gap, **When** the opportunities are listed,
   **Then** it appears with the AI citation gap type and its evidence.
2. **Given** an assistant asking for the gaps, **When** it calls the read-only
   MCP tool, **Then** it receives the rows for the project it is authorized for.

### Edge Cases

- A run with no citations is a gap, not a missing observation.
- A run whose only citation is our own page is not a "cited without us" finding.
- The same domain cited by two models in one run counts once per run.
- A citation URL that is not http(s) is never stored (the existing URL
  sanitizer decides).
- Two runs with the same prompt but different answers are two observations.
- A project with a single recorded run is a small sample.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST store AI search observations in two new tables,
  `ai_search_runs` and `ai_search_citations`, in both dialects, with dual
  migrations and schema parity.
- **FR-002**: A run row MUST carry the provider, the model, the observed model
  name, the prompt hash, the prompt length, the web-search flag, the country
  code, the output token count, the fan-out count, the citation count, the
  status, the content-hash event key, and the observation timestamp.
- **FR-003**: The system MUST NOT store the raw prompt, the raw answer text, or
  any other user-authored text in the run or citation rows. Only hashes, counts,
  and sanitized URLs may be persisted.
- **FR-004**: A citation row MUST carry the run, the project, the sanitized URL,
  the domain, the title, the position inside the answer, and the observation
  timestamp; the same URL must not be stored twice for one run.
- **FR-005**: The event key MUST be a content hash of the observed answer, so the
  same observation is recorded once.
- **FR-006**: Recording MUST run inside the Prompt Explorer and MUST be
  isolated: a failed write MUST NOT break the explorer or change the answer.
- **FR-007**: The gap analysis MUST reuse the existing citation extraction and
  MUST separate citations (pages the model cited) from mentions (a brand named
  in the answer text).
- **FR-008**: The gap analysis MUST emit at most three finding families: cited
  without us, frequently cited third party, and a run with no cited sources.
- **FR-009**: Findings MUST state the observed counts and MUST carry a small
  sample label when the observation count is below the injected floor.
- **FR-010**: The gap analysis MUST be registered as an intelligence detector
  with an `ai_search` source version, and MUST produce opportunities through the
  existing materializer path (no new opportunity engine).
- **FR-011**: A read-only MCP tool MUST return the recorded AI citation gaps for
  the authorized project.
- **FR-012**: The budget, plan-gate, and per-model error isolation of the
  Prompt Explorer MUST be unchanged, and no detector may call a paid provider.

### Non-Functional Requirements

- **NFR-001**: No new paid provider call: the observations come from the
  Prompt Explorer runs the user already triggered.
- **NFR-002**: Bounded: at most 25 citations per run (the existing extraction
  cap) and a bounded number of runs read per analysis.
- **NFR-003**: Deterministic: identical stored rows and thresholds produce
  identical findings, ordering, and opportunity identity.
- **NFR-004**: The stored rows stay JSON-serializable and dialect-parity safe.

### Key Entities

- **AiSearchRun**: one observed model answer (hashed prompt, model, tokens,
  fan-outs, event key).
- **AiSearchCitation**: one page the model cited in a run.
- **AiCitationGap**: a finding family with its observed counts.

## Success Criteria _(mandatory)_

- **SC-001**: A Prompt Explorer run is recorded with the model, tokens, fan-out
  count, and one row per cited URL, and no prompt text is stored.
- **SC-002**: A failed write leaves the explorer working.
- **SC-003**: The three finding families are produced from seeded observations,
  each with its observed counts.
- **SC-004**: A finding below the observation floor carries the small-sample
  label and a lower confidence.
- **SC-005**: The gaps are listed as opportunities with the AI citation gap
  type, and the MCP tool returns them for the authorized project.
- **SC-006**: Unit suites, schema parity, `tsc`, Prettier, oxlint, knip, the
  full Vitest suite, and `pnpm build` are green (one known env-gated live-API
  failure excepted).

## Assumptions

- The Prompt Explorer already isolates per-model errors, enforces the budget and
  the plan gate, and caps the citations at 25.
- The raw prompt stays where it is today (client history, URL, R2 cache); the
  database keeps only hashes and counts.
- "Topic" is the prompt of a run; there is no topic taxonomy in the product, so
  the topic gap is expressed per run.
- The project's own domain comes from the project record.
- The AI search observations are the only source the gap detector reads; it
  never calls a provider.
