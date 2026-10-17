# Maintainer Competitor-Gap Spike Invocation Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a minimal, secure maintainer-only authenticated invocation surface in OpenSEO's existing Settings/Debug tools to execute `runCompetitorGapSpike` exactly once with the frozen manifest, robust duplicate prevention, and complete verdict polling/display.

**Architecture:** A dedicated maintainer component (`MaintainerSpikeTrigger`) placed in `ProjectSettings` (`/_project/p/$projectId/settings`), gated by maintainer authorization checks and project context. The trigger binds directly to a deeply frozen manifest constant mirroring `specs/014-competitor-gap-conditional/spike-manifest.md`. Before invocation, it inspects `getCompetitorGapVerdict`; if a verdict row exists, invocation is aborted and existing verdict details are shown. During invocation, double-clicks and concurrent calls are locked out. Upon completion, it polls `getCompetitorGapVerdict` and presents all required metrics and dimensions.

**Tech Stack:** React 19, TypeScript, TanStack Start server functions (`runCompetitorGapSpike`, `getCompetitorGapVerdict`), TanStack Query, Vitest.

**Spec:** [spike-manifest.md](file:///f:/SEO-Dashboard/specs/014-competitor-gap-conditional/spike-manifest.md) and [contracts/spike-and-verdict.md](file:///f:/SEO-Dashboard/specs/014-competitor-gap-conditional/contracts/spike-and-verdict.md)

## Global Constraints

- Reuse existing server function `runCompetitorGapSpike` without modification or bypassing.
- Do NOT add unauthenticated routes, direct DB writes, direct provider calls, fabricated billing context, or public MCP registration.
- Invocation surface requires normal authenticated project context and project/org authorization.
- Label action clearly as "Run Competitor Gap Spike".
- Read frozen values from `specs/014-competitor-gap-conditional/spike-manifest.md` via checked-in frozen constant; UI must never allow editing thresholds, competitors, market, budget, or keywordSetRef.
- Display frozen manifest values before execution; require explicit confirmation before running.
- Exactly-once safety: before invoking, check `getCompetitorGapVerdict`; if a verdict row already exists, do NOT invoke again and display existing verdict and ledger row ID.
- During execution: display running state, prevent duplicate-click execution, display server error if invocation fails.
- After completion: poll `getCompetitorGapVerdict` and display VERDICT, LEDGER_ROW_ID, keywordCoverageRatio, firstPartyCoverageRatio, costPerAnalysisCredits, repeatCacheHitRate, repeatAnalysisPaidCalls, identityCollisions, identityDeterministic, unavailable dimensions.
- Keep surface maintainer-only: must not become a normal end-user feature.
- Do not modify the frozen manifest file `specs/014-competitor-gap-conditional/spike-manifest.md`.

## Review Focus

- Unauthenticated or non-maintainer request must be rejected / hidden; end users never see the action.
- Wrong project or organization context must fail authorization and be rejected with standard server error (`NOT_FOUND` / `UNAUTHENTICATED`).
- Existing verdict in the ledger must block execution before `runCompetitorGapSpike` can ever be called.
- In-flight double-click or rapid multi-click must never trigger duplicate executions.
- Frozen manifest values must remain completely immutable in runtime and UI.

---

### Task 1: Checked-In Frozen Manifest and Maintainer Gate Utilities

**Files:**

- Create: `src/client/features/competitor-gap/frozenSpikeManifest.ts`
- Create: `src/client/features/competitor-gap/maintainerAccess.ts`
- Test: `src/client/features/competitor-gap/frozenSpikeManifest.test.ts`

**Interfaces:**

- Consumes: `specs/014-competitor-gap-conditional/spike-manifest.md`
- Produces: `FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST`, `isMaintainerSurfaceEnabled(searchParams?: URLSearchParams, storage?: Storage): boolean`

- [ ] **Step 1: Write failing tests for frozen manifest and maintainer access**

Create `src/client/features/competitor-gap/frozenSpikeManifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";
import { isMaintainerSurfaceEnabled } from "./maintainerAccess";

describe("FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST", () => {
  it("matches frozen manifest values exactly", () => {
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId).toBe(
      "bb267736-5e5e-9f5f-7d78260abbde",
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.sampleDomains).toEqual([
      "emtyiaz.com",
      "manaraa.com",
      "bahthy.com",
    ]);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.keywordSetRef).toBe(
      "gsc-top-queries-2026-10-09",
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.market).toEqual({
      locationCode: 2784,
      languageCode: "ar",
    });
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.budgetCapCredits).toBe(500);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.timeBoxHours).toBe(4);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds).toEqual({
      minKeywordCoverageRatio: 0.5,
      minFirstPartyCoverageRatio: 0.5,
      maxCostPerAnalysisCredits: 100,
      repeatCacheHitRate: 1.0,
      identityCollisionsAllowed: 0,
    });
  });

  it("is deeply frozen and immutable at runtime", () => {
    expect(Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST)).toBe(true);
    expect(
      Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.sampleDomains),
    ).toBe(true);
    expect(Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.market)).toBe(
      true,
    );
    expect(
      Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds),
    ).toBe(true);
  });
});

describe("isMaintainerSurfaceEnabled", () => {
  it("enables via search parameter ?maintainer=1", () => {
    const params = new URLSearchParams("maintainer=1");
    expect(isMaintainerSurfaceEnabled({ searchParams: params })).toBe(true);
  });

  it("enables via storage flag", () => {
    const mockStorage = {
      getItem: (key: string) =>
        key === "openseo:maintainer_mode" ? "true" : null,
    } as unknown as Storage;
    expect(isMaintainerSurfaceEnabled({ storage: mockStorage })).toBe(true);
  });

  it("disables when neither flag is set and not in dev/env mode", () => {
    const params = new URLSearchParams();
    const mockStorage = { getItem: () => null } as unknown as Storage;
    expect(
      isMaintainerSurfaceEnabled({
        searchParams: params,
        storage: mockStorage,
        isDev: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/client/features/competitor-gap/frozenSpikeManifest.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement frozen manifest and maintainer access**

Create `src/client/features/competitor-gap/frozenSpikeManifest.ts`:

```ts
// Spec 014: Frozen Competitor-Gap Spike Manifest Constant
// Generated verbatim from specs/014-competitor-gap-conditional/spike-manifest.md §9.
// IMMUTABLE: Must never be altered or mutated at runtime.

import type { CompetitorGapSpikeInput } from "@/types/schemas/competitorGap";

export const FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST: Readonly<CompetitorGapSpikeInput> =
  Object.freeze({
    projectId: "bb267736-5e5e-9f5f-7d78260abbde",
    sampleDomains: Object.freeze(["emtyiaz.com", "manaraa.com", "bahthy.com"]),
    keywordSetRef: "gsc-top-queries-2026-10-09",
    market: Object.freeze({
      locationCode: 2784,
      languageCode: "ar",
    }),
    budgetCapCredits: 500,
    timeBoxHours: 4,
    thresholds: Object.freeze({
      minKeywordCoverageRatio: 0.5,
      minFirstPartyCoverageRatio: 0.5,
      maxCostPerAnalysisCredits: 100,
      repeatCacheHitRate: 1.0,
      identityCollisionsAllowed: 0,
    }),
  });
```

Create `src/client/features/competitor-gap/maintainerAccess.ts`:

```ts
// Maintainer-only guard for internal diagnostic and spike surfaces.
// Ensures developer/maintainer tools remain invisible to regular end users.

type MaintainerCheckOptions = {
  searchParams?: URLSearchParams;
  storage?: Storage | null;
  isDev?: boolean;
};

export function isMaintainerSurfaceEnabled(
  options?: MaintainerCheckOptions,
): boolean {
  const isDev =
    options?.isDev ??
    (typeof import.meta !== "undefined" &&
      (import.meta.env?.DEV || import.meta.env?.VITE_MAINTAINER_MODE === "1"));
  if (isDev) return true;

  try {
    const searchParams =
      options?.searchParams ??
      (typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null);
    if (searchParams) {
      const val = searchParams.get("maintainer");
      if (val === "1" || val === "true") return true;
    }
  } catch {
    // ignore
  }

  try {
    const storage =
      options?.storage ??
      (typeof window !== "undefined" ? window.localStorage : null);
    if (storage) {
      const item = storage.getItem("openseo:maintainer_mode");
      if (item === "1" || item === "true") return true;
    }
  } catch {
    // ignore
  }

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/client/features/competitor-gap/frozenSpikeManifest.test.ts`
Expected: PASS

---

### Task 2: Server Function Authorization & Unauthenticated Guard Tests

**Files:**

- Modify: `src/serverFunctions/competitorGap.authorization.test.ts`

**Interfaces:**

- Consumes: `runCompetitorGapSpike`, `getCompetitorGapVerdict`
- Produces: Verified server-level guards (unauthenticated rejected, wrong project/org rejected)

- [ ] **Step 1: Add tests for unauthenticated invocation rejection**

Add to `src/serverFunctions/competitorGap.authorization.test.ts`:

```ts
it.each([
  ["runCompetitorGapSpike", runCompetitorGapSpike],
  ["getCompetitorGapVerdict", getCompetitorGapVerdict],
])("rejects unauthenticated access before %s runs", async (_name, fn) => {
  mocks.resolveUser.mockRejectedValue(new Error("UNAUTHENTICATED"));

  const result = await executeServerFunction(fn, SPIKE_INPUT);
  expect(result).toMatchObject({ error: new Error("UNAUTHENTICATED") });
  expect(mocks.runSpike).not.toHaveBeenCalled();
  expect(mocks.gateState).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run src/serverFunctions/competitorGap.authorization.test.ts`
Expected: PASS

---

### Task 3: Maintainer UI Component with Immutable Values, Confirmation, Exactly-Once Guard, Polling & Metric Display

**Files:**

- Create: `src/client/features/competitor-gap/MaintainerSpikeTrigger.tsx`
- Create: `src/client/features/competitor-gap/MaintainerSpikeTrigger.test.ts`

**Interfaces:**

- Consumes: `FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST`, `isMaintainerSurfaceEnabled`, `runCompetitorGapSpike`, `getCompetitorGapVerdict`
- Produces: `MaintainerSpikeTrigger({ projectId }: { projectId: string })`

- [ ] **Step 1: Write failing unit & logic tests for MaintainerSpikeTrigger**

Create `src/client/features/competitor-gap/MaintainerSpikeTrigger.test.ts`:

- Test duplicate execution prevented when verdict already exists: calls `getCompetitorGapVerdict`, if verdict row present, does NOT invoke `runCompetitorGapSpike` and displays existing verdict & ledger row ID.
- Test double-click/in-flight duplicate prevented: concurrent clicks invoke server function only once.
- Test manifest values are immutable from the UI: inputs are not editable, values match frozen manifest.
- Test successful invocation reads recorded ledger verdict: invokes `runCompetitorGapSpike` and displays verdict, ledger row ID, and all 9 required metrics + unavailable dimensions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/client/features/competitor-gap/MaintainerSpikeTrigger.test.ts`
Expected: FAIL (component not found)

- [ ] **Step 3: Implement MaintainerSpikeTrigger**

Create `src/client/features/competitor-gap/MaintainerSpikeTrigger.tsx`:
Implement full component:

- Maintainer check (`isMaintainerSurfaceEnabled`). If false, returns null.
- Renders frozen manifest summary in clear read-only layout (project ID, competitors, market, keyword set ref, budget cap, thresholds). No edit controls.
- Requires explicit confirmation checkbox ("I confirm execution of the frozen spike manifest (budget cap 500 credits, exactly once)").
- Action button labeled: "Run Competitor Gap Spike".
- On click:
  1. If already executing (`inFlightRef`), bail.
  2. Query `getCompetitorGapVerdict` first. If a verdict row exists, abort execution, display existing verdict and ledger row ID.
  3. Execute `runCompetitorGapSpike({ data: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST })`.
  4. On error, display server error alert.
  5. On success, poll `getCompetitorGapVerdict({ data: { projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId } })` and display:
     - VERDICT
     - LEDGER_ROW_ID
     - keywordCoverageRatio
     - firstPartyCoverageRatio
     - costPerAnalysisCredits
     - repeatCacheHitRate
     - repeatAnalysisPaidCalls
     - identityCollisions
     - identityDeterministic
     - unavailable dimensions

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/client/features/competitor-gap/MaintainerSpikeTrigger.test.ts`
Expected: PASS

---

### Task 4: Integrate Maintainer Surface into Project Settings / Developer Tools

**Files:**

- Modify: `src/client/features/projects/ProjectSettings.tsx`

**Interfaces:**

- Consumes: `<MaintainerSpikeTrigger projectId={projectId} />`

- [ ] **Step 1: Add Maintainer section in ProjectSettings**

Place `<MaintainerSpikeTrigger projectId={projectId} />` in `ProjectSettings.tsx` under a dedicated Developer / Maintainer tools section or right by Debug Trace.

- [ ] **Step 2: Verify type checks and lint pass**

Run: `pnpm types:check`
Run: `pnpm lint`

---

### Task 5: End-to-End Verification and Verification Suite

**Files:**

- Run all related test suites:
  - `src/serverFunctions/competitorGap.authorization.test.ts`
  - `src/client/features/competitor-gap/frozenSpikeManifest.test.ts`
  - `src/client/features/competitor-gap/MaintainerSpikeTrigger.test.ts`
- Run `pnpm types:check`
- Run `pnpm lint`

- [ ] **Step 1: Execute all verification tests**
- [ ] **Step 2: Confirm all 6 test obligations from Requirement 12 are met**
- [ ] **Step 3: Return exact output status tokens**

```text
MAINTAINER_TRIGGER = READY
AUTH_GUARD = PASS
DUPLICATE_GUARD = PASS
MANIFEST_IMMUTABLE = YES
```
