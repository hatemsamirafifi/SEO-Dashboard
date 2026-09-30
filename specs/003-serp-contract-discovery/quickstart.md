# Quickstart: SERP Contract Discovery and Freeze

**Feature**: `003-serp-contract-discovery` | **Date**: 2026-09-28

Validation guide. See [spec](spec.md), [contract](contracts/serp-snapshot.md).

## Prerequisites

- Repo checked out; familiarity with `src/server/features/serp/`; `pnpm types:check` green.

## Scenarios

### 1. Discovery walkthrough (engineer test)

1. Give [research.md](research.md) §Decision 1 to an engineer unfamiliar with the SERP code.
2. They trace one keyword: entry → resolver → provider order → normalization → cache → cost → trace.
3. **Expect**: zero corrections to file references; any doc-vs-code discrepancy explicitly listed in the report.

### 2. Contract fixture validation

1. Build two fixtures against [contracts/serp-snapshot.md](contracts/serp-snapshot.md): full (all families)
   and sparse (half families absent).
2. Validate both against the frozen schema.
3. **Expect**: both pass; sparse snapshot marks absent families as absent (no fabrication, no null-coercion).

### 3. Vocabulary + no-raw-parsing audit

1. Review contract metric names against provider docs; scan UI/detector code for raw-provider imports.
2. **Expect**: zero DA/PA/DR/TF/CF labels; zero raw-provider parsing outside the resolver.

### 4. G4 sign-off

1. Confirm downstream packages 007/011 reference this contract as mandatory input.
2. **Expect**: G4 recorded satisfied in `docs/speckit-implementation-plan.md` (gate update task).

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test serp/types   # contract fixture tests (name per implementation)
```
