import type { DataforseoAccountSlotStore } from "@/server/features/rank-tracking/repositories/DataforseoAccountGateRepository";

// Account-coordinated dispatch gate for DataForSEO rank-check requests
// (task_post, task_get, single-keyword Live).
//
// At most ONE rank-check request is in flight per DataForSEO account, no
// matter how many projects/orgs/workers share that account (same effective
// login; the API password may differ between scopes). The D1/Postgres slot
// row (dataforseo_account_request_slots) is the authority — this module adds
// only a bounded, cancellation-aware wait loop around it. There is NO
// in-process fairness structure on purpose: cross-worker FIFO cannot be
// enforced from process-local state, so every waiter polls the shared row
// independently at a modest, jittered cadence.
//
// Guarantees:
//  - Bounded wait: the deadline starts when withRequest is called and covers
//    queue time + acquisition; a timed-out or cancelled wait NEVER
//    dispatches (dispatch happens only after acquire, in the same call).
//  - Cancellation: an AbortSignal and/or an async isCancelled callback are
//    checked before every poll and once more immediately after acquiring,
//    so a cancelled run cannot dispatch even when the slot frees late.
//  - Crash recovery: a holder that dies without releasing is reclaimed by
//    the next acquirer once the lease lapses; the epoch bump fences the dead
//    owner's later release into a no-op.
//  - Fail-closed: coordination-storage errors abort before any dispatch.
//  - Lease safety: the lease must outlive the caller's worst-case dispatch.
//    Every gated call goes through the shared DataForSEO fetch, hard-capped
//    at ~61s (60s AbortSignal across ≤3 attempts + backoff), so the 120s
//    default lease includes both the acquisition wait and the network window.

export type DataforseoRankCheckRequestKind =
  | "task_post"
  | "task_get"
  | "live_rank_check";

export class DataforseoAccountGateBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataforseoAccountGateBusyError";
  }
}

export class DataforseoAccountGateUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataforseoAccountGateUnavailableError";
  }
}

/** Thrown when the wait was cancelled (signal or isCancelled): nothing was sent. */
export class DataforseoAccountGateCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError"; // matches the existing cancellation vocabulary
  }
}

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_PACING_MS = 150;
const DEFAULT_WAIT_TIMEOUT_MS = 45_000;

// Modest polling: never faster than 500ms in production, jittered so
// concurrent waiters (and other workers) don't synchronize their write
// attempts, capped at 2s. Tests may override pollIntervalMs for speed.
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 2_000;

function pollDelayMs(baseMs: number, remainingMs: number): number {
  const jittered = Math.max(1, baseMs) * (1 + Math.random());
  return Math.max(1, Math.min(jittered, POLL_MAX_MS, remainingMs));
}

/** Cancellable, bounded sleep; rejects with AbortError when `signal` fires. */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new DataforseoAccountGateCancelledError(
        "DataForSEO account gate wait aborted",
      );
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface DataforseoAccountGateRequestOptions {
  /** Hard cap on the TOTAL wait (queue + acquisition), from call time. */
  waitTimeoutMs?: number;
  /** Lease duration while the request is in flight (crash-recovery bound). */
  leaseMs?: number;
  /** Minimum spacing after this request before the account serves the next. */
  pacingMs?: number;
  /** Base DB poll interval while waiting. Tests use small values for speed;
   *  production uses the documented 500ms default. */
  pollIntervalMs?: number;
  /** Aborts the WAIT (never an in-flight fn). */
  signal?: AbortSignal;
  /** Async liveness check (e.g. run not cancelled), checked while waiting and
   *  once more after acquiring, immediately before dispatch. */
  isCancelled?: () => Promise<boolean>;
}

/**
 * A gate bound to one slot store. Production code shares the module-level
 * singleton; tests create several gates over one store to model independent
 * dispatcher workers.
 */
export function createDataforseoAccountGate(store: DataforseoAccountSlotStore) {
  async function withRequest<T>(
    accountHash: string,
    kind: DataforseoRankCheckRequestKind,
    fn: () => Promise<T>,
    options: DataforseoAccountGateRequestOptions = {},
  ): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(accountHash)) {
      throw new DataforseoAccountGateUnavailableError(
        "Refusing to coordinate an account without a SHA-256 identifier",
      );
    }
    // The deadline is set at CALL time, so queue contention counts against
    // the caller's budget — a waiter can never outlive its own bound.
    const deadline =
      Date.now() + (options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    const label = accountHash.slice(0, 16);

    function assertWaitOpen(): void {
      if (options.signal?.aborted) {
        throw new DataforseoAccountGateCancelledError(
          "DataForSEO account gate wait aborted",
        );
      }
      if (Date.now() >= deadline) {
        throw new DataforseoAccountGateBusyError(
          `DataForSEO account gate busy for ${kind}; gave up after ${Math.round((options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1000)}s`,
        );
      }
    }

    async function checkWait(): Promise<void> {
      assertWaitOpen();
      if (options.isCancelled && (await options.isCancelled())) {
        throw new DataforseoAccountGateCancelledError(
          "Rank check was cancelled while waiting for the DataForSEO account slot",
        );
      }
      assertWaitOpen();
    }

    for (let attempt = 0; ; attempt++) {
      await checkWait();

      const nowIso = new Date().toISOString();
      const leaseUntilIso = new Date(Date.now() + leaseMs).toISOString();
      let acquired: { epoch: number } | null = null;
      try {
        acquired =
          (await store.tryAcquireSlot({
            accountHash,
            nowIso,
            leaseUntilIso,
          })) ??
          (await store.tryCreateSlot({ accountHash, nowIso, leaseUntilIso }));
      } catch (cause) {
        // FAIL CLOSED: no slot, no dispatch. Never silently bypass the gate.
        throw new DataforseoAccountGateUnavailableError(
          "DataForSEO account coordination storage failed; refusing to dispatch without coordination",
          { cause },
        );
      }

      if (acquired) {
        console.log(
          `[dataforseo-gate] account=${label} kind=${kind} acquired epoch=${acquired.epoch} attempt=${attempt + 1}`,
        );
        try {
          // Acquisition and the liveness query can both finish after an abort
          // or deadline. Always release, including when that query throws.
          await checkWait();
          return await fn();
        } finally {
          await releaseSlot(accountHash, kind, acquired.epoch, options);
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DataforseoAccountGateBusyError(
          `DataForSEO account gate busy for ${kind}; gave up after ${Math.round((options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1000)}s`,
        );
      }
      await cancellableSleep(
        pollDelayMs(options.pollIntervalMs ?? POLL_MIN_MS, remaining),
        options.signal,
      );
    }
  }

  async function releaseSlot(
    accountHash: string,
    kind: DataforseoRankCheckRequestKind,
    epoch: number,
    options: DataforseoAccountGateRequestOptions,
  ): Promise<void> {
    const label = accountHash.slice(0, 16);
    const pacingMs = Math.max(0, options.pacingMs ?? DEFAULT_PACING_MS);
    try {
      const released = await store.releaseSlot({
        accountHash,
        epoch,
        freeAtIso: new Date(Date.now() + pacingMs).toISOString(),
      });
      if (!released) {
        // Fenced stale release (slot reclaimed after lease expiry): the newer
        // owner keeps the slot. Expected during crash recovery.
        console.warn(
          `[dataforseo-gate] account=${label} kind=${kind} stale release fenced (epoch=${epoch})`,
        );
        return;
      }
      console.log(
        `[dataforseo-gate] account=${label} kind=${kind} released epoch=${epoch} pacing_ms=${pacingMs}`,
      );
    } catch (error) {
      // The request already ran — a release failure must not turn success
      // into failure. The lease self-heals the slot.
      console.warn(
        `[dataforseo-gate] account=${label} kind=${kind} release failed (lease will expire):`,
        error,
      );
    }
  }

  return { withRequest };
}

let defaultGatePromise: Promise<ReturnType<typeof createDataforseoAccountGate>>;

/**
 * The shared gate wired into the real DataForSEO rank-check dispatch path
 * (serp.ts). Lazily binds to the repository so importing this module never
 * loads the DB stack eagerly.
 */
export function withDataforseoAccountRequest<T>(
  accountHash: string,
  kind: DataforseoRankCheckRequestKind,
  fn: () => Promise<T>,
  options: DataforseoAccountGateRequestOptions = {},
): Promise<T> {
  defaultGatePromise ??=
    import("@/server/features/rank-tracking/repositories/DataforseoAccountGateRepository").then(
      ({ DataforseoAccountGateRepository }) =>
        createDataforseoAccountGate(DataforseoAccountGateRepository),
    );
  return defaultGatePromise.then((gate) =>
    gate.withRequest(accountHash, kind, fn, options),
  );
}
