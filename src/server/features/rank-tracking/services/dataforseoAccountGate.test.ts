import { afterAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";

// Real coordination semantics against a REAL scratch SQLite database: @/db is
// replaced with a drizzle-libsql instance over a scratch database that has the
// actual generated migration applied. Two `createDataforseoAccountGate`
// instances over the same store model two independent dispatcher workers
// (isolates) sharing one D1 database.

vi.mock("cloudflare:workers", () => ({ env: {} }));

const storeHandle = vi.hoisted(() => ({
  client: undefined as Client | undefined,
}));

vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const client = createClient({ url: "file::memory:" });
  const migration = readFileSync(
    path.resolve(
      process.cwd(),
      "drizzle/0077_dataforseo_account_request_slots.sql",
    ),
    "utf8",
  );
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await client.execute(statement);
  }
  storeHandle.client = client;
  return {
    db: drizzle(client),
    withPgClient: async <T>(fn: () => Promise<T>) => fn(),
  };
});

import { DataforseoAccountGateRepository } from "@/server/features/rank-tracking/repositories/DataforseoAccountGateRepository";
import {
  createDataforseoAccountGate,
  DataforseoAccountGateBusyError,
  DataforseoAccountGateCancelledError,
  DataforseoAccountGateUnavailableError,
  withDataforseoAccountRequest,
} from "@/server/features/rank-tracking/services/dataforseoAccountGate";

const FAST_POLL = { pollIntervalMs: 10, pacingMs: 0 } as const;

/** Two independent gate instances over the shared store (two "workers"). */
const gateA = () =>
  createDataforseoAccountGate(DataforseoAccountGateRepository);
const gateB = () =>
  createDataforseoAccountGate(DataforseoAccountGateRepository);

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scratchClient(): Client {
  if (!storeHandle.client)
    throw new Error("Scratch database was not initialized");
  return storeHandle.client;
}

afterAll(() => {
  storeHandle.client?.close();
});

describe("DataForSEO account gate: shared-slot coordination on scratch SQLite", () => {
  it("never overlaps requests for the same account across two independent gate instances", async () => {
    const gate1 = gateA();
    const gate2 = gateB();
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    const run = (gate: ReturnType<typeof gateA>, id: number) =>
      gate.withRequest(
        ACCOUNT_A,
        "task_get",
        async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(2 + (id % 3));
          inFlight -= 1;
          completed += 1;
          return id;
        },
        { ...FAST_POLL, waitTimeoutMs: 20_000 },
      );

    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => run(gate1, i)),
      ...Array.from({ length: 10 }, (_, i) => run(gate2, 100 + i)),
    ]);

    expect(results).toHaveLength(20);
    expect(completed).toBe(20);
    expect(maxInFlight).toBe(1);
  });

  it("allows different accounts to overlap", async () => {
    const gate1 = gateA();
    const gate2 = gateB();
    let inFlight = 0;
    let maxInFlight = 0;
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((r) => (secondStarted = r));
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => (releaseFirst = r));

    const first = gate1.withRequest(
      ACCOUNT_A,
      "task_get",
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await firstDone;
        inFlight -= 1;
      },
      { ...FAST_POLL },
    );
    // Give request one time to acquire the slot before starting the second.
    await sleep(50);

    const second = gate2.withRequest(
      ACCOUNT_B,
      "task_get",
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        secondStarted();
        await sleep(10);
        inFlight -= 1;
      },
      { ...FAST_POLL },
    );

    await secondStartedPromise;
    releaseFirst();
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(2);
  });

  it("rejects a waiter promptly when its bounded wait expires behind a held slot, and never dispatches it later", async () => {
    const gate1 = gateA();
    const gate2 = gateB();
    let releaseHead!: () => void;
    let headDispatched = false;

    const head = gate1.withRequest(
      ACCOUNT_A,
      "task_get",
      async () => {
        headDispatched = true;
        await new Promise<void>((r) => (releaseHead = r));
      },
      { ...FAST_POLL, leaseMs: 60_000 },
    );
    await sleep(50);
    expect(headDispatched).toBe(true);

    let dispatched = false;
    const startedAt = Date.now();
    const waiter = gate2.withRequest(
      ACCOUNT_A,
      "task_post",
      async () => {
        dispatched = true;
      },
      { ...FAST_POLL, waitTimeoutMs: 60 },
    );

    const outcome = await Promise.race([
      waiter.then(
        () => "resolved",
        () => "rejected",
      ),
      sleep(400).then(() => "still-pending"),
    ]);

    // The waiter rejected while the head still held the slot...
    expect(outcome).toBe("rejected");
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(headDispatched).toBe(true);

    releaseHead();
    await head;
    await sleep(100);
    // ...and the timed-out request was NEVER sent, even after the slot freed.
    expect(dispatched).toBe(false);
  });

  it("aborts a waiting request via AbortSignal without dispatching and without leaking the slot", async () => {
    const gate1 = gateA();
    const gate2 = gateB();
    let releaseHead!: () => void;
    const head = gate1.withRequest(
      ACCOUNT_A,
      "task_get",
      () => new Promise<void>((r) => (releaseHead = r)),
      { ...FAST_POLL, leaseMs: 60_000 },
    );
    await sleep(50);

    const controller = new AbortController();
    let dispatched = false;
    const waiter = gate2.withRequest(
      ACCOUNT_A,
      "task_post",
      async () => {
        dispatched = true;
      },
      { ...FAST_POLL, signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 30);
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatched).toBe(false);

    releaseHead();
    await head;

    // The aborted waiter left the slot usable: the next request acquires.
    const gate3 = gateA();
    await expect(
      gate3.withRequest(ACCOUNT_A, "task_get", async () => "ok", {
        ...FAST_POLL,
        waitTimeoutMs: 5_000,
      }),
    ).resolves.toBe("ok");
  });

  it("honors the isCancelled callback while waiting and right after acquiring", async () => {
    // (a) while waiting behind a held slot: nothing is dispatched.
    const gate1 = gateA();
    const gate2 = gateB();
    let releaseHead!: () => void;
    const head = gate1.withRequest(
      ACCOUNT_A,
      "task_get",
      () => new Promise<void>((r) => (releaseHead = r)),
      { ...FAST_POLL, leaseMs: 60_000 },
    );
    await sleep(50);

    let dispatchedWhileWaiting = false;
    const waiter = gate2.withRequest(
      ACCOUNT_A,
      "task_post",
      async () => {
        dispatchedWhileWaiting = true;
      },
      { ...FAST_POLL, waitTimeoutMs: 10_000, isCancelled: async () => true },
    );
    await expect(waiter).rejects.toBeInstanceOf(
      DataforseoAccountGateCancelledError,
    );
    expect(dispatchedWhileWaiting).toBe(false);
    releaseHead();
    await head;

    // (b) the run is cancelled between acquiring the slot and dispatching:
    // an observing store flips `acquired` when the slot is granted, and the
    // gate's post-acquire re-check must refuse to send.
    let acquired = false;
    const observingStore = {
      tryAcquireSlot: async (input: {
        accountHash: string;
        nowIso: string;
        leaseUntilIso: string;
      }) => {
        const lease =
          await DataforseoAccountGateRepository.tryAcquireSlot(input);
        if (lease) acquired = true;
        return lease;
      },
      tryCreateSlot: DataforseoAccountGateRepository.tryCreateSlot.bind(
        DataforseoAccountGateRepository,
      ),
      releaseSlot: DataforseoAccountGateRepository.releaseSlot.bind(
        DataforseoAccountGateRepository,
      ),
    };
    let dispatchedAfterAcquire = false;
    const gate4 = createDataforseoAccountGate(observingStore);
    await expect(
      gate4.withRequest(
        ACCOUNT_A,
        "task_get",
        async () => {
          dispatchedAfterAcquire = true;
        },
        {
          ...FAST_POLL,
          waitTimeoutMs: 10_000,
          isCancelled: async () => acquired,
        },
      ),
    ).rejects.toBeInstanceOf(DataforseoAccountGateCancelledError);
    expect(dispatchedAfterAcquire).toBe(false);

    // The refused dispatch released the slot: the next request acquires.
    const gate5 = gateA();
    await expect(
      gate5.withRequest(ACCOUNT_A, "task_get", async () => "ok", {
        ...FAST_POLL,
        waitTimeoutMs: 5_000,
      }),
    ).resolves.toBe("ok");
  });
});

describe("DataForSEO account gate lease recovery and validation", () => {
  it("recovers a crashed holder's slot after lease expiry and fences its stale release", async () => {
    // A FRESH account (no slot row yet): simulate a crashed worker by
    // creating + holding the slot WITHOUT ever releasing it.
    const crashedAccount = "c".repeat(64);
    const nowIso = new Date().toISOString();
    const oldLease = await DataforseoAccountGateRepository.tryCreateSlot({
      accountHash: crashedAccount,
      nowIso,
      leaseUntilIso: new Date(Date.now() + 120).toISOString(),
    });
    expect(oldLease?.epoch).toBe(1);

    await sleep(200); // lease lapses

    // A healthy worker reclaims the expired slot (epoch bumps to 2).
    let releaseWorker!: () => void;
    const gate = gateA();
    const worker = gate.withRequest(
      crashedAccount,
      "task_get",
      () => new Promise<void>((r) => (releaseWorker = r)),
      {
        ...FAST_POLL,
        waitTimeoutMs: 5_000,
        leaseMs: 60_000,
      },
    );
    await sleep(100);
    const row = await scratchClient().execute(
      `SELECT epoch FROM dataforseo_account_request_slots WHERE account_hash = '${crashedAccount}'`,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- libsql rows are untyped records
    expect(Number((row.rows[0] as unknown as { epoch: number }).epoch)).toBe(2);

    // The crashed owner's stale release must NOT unlock the new owner.
    const staleRelease = await DataforseoAccountGateRepository.releaseSlot({
      accountHash: crashedAccount,
      epoch: oldLease!.epoch,
      freeAtIso: new Date().toISOString(),
    });
    expect(staleRelease).toBe(false);

    // The new owner finishes normally; the next request acquires.
    releaseWorker();
    await worker;
    await expect(
      gate.withRequest(crashedAccount, "task_get", async () => "ok", {
        ...FAST_POLL,
        waitTimeoutMs: 5_000,
      }),
    ).resolves.toBe("ok");
  });

  it("fails closed when coordination storage errors (no dispatch)", async () => {
    const brokenStore = {
      tryAcquireSlot: async () => {
        throw new Error("D1 is down");
      },
      tryCreateSlot: async () => {
        throw new Error("D1 is down");
      },
      releaseSlot: async () => true,
    };
    const gate = createDataforseoAccountGate(brokenStore);
    let dispatched = false;
    await expect(
      gate.withRequest(
        ACCOUNT_A,
        "task_post",
        async () => {
          dispatched = true;
        },
        { ...FAST_POLL },
      ),
    ).rejects.toBeInstanceOf(DataforseoAccountGateUnavailableError);
    expect(dispatched).toBe(false);
  });

  it("bounds the total wait from call time (queue time included)", async () => {
    const gate1 = gateA();
    const gate2 = gateB();
    // A held slot that frees well after the waiter's budget is gone.
    let releaseHead!: () => void;
    const head = gate1.withRequest(
      ACCOUNT_A,
      "task_get",
      () => new Promise<void>((r) => (releaseHead = r)),
      { ...FAST_POLL, leaseMs: 120_000 },
    );
    await sleep(50);

    const startedAt = Date.now();
    const attempt = gate2.withRequest(
      ACCOUNT_A,
      "task_post",
      async () => "sent",
      {
        pollIntervalMs: 10,
        pacingMs: 0,
        waitTimeoutMs: 250,
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(
      DataforseoAccountGateBusyError,
    );
    const elapsed = Date.now() - startedAt;
    // Rejected within ~the budget (+ poll slack), not after the head releases.
    expect(elapsed).toBeLessThan(800);
    releaseHead();
    await head;
  });

  it("rejects a non-SHA-256 account identifier (fail closed on bad binding)", async () => {
    const gate = gateA();
    await expect(
      gate.withRequest("not-a-hash", "task_get", async () => "sent", {
        ...FAST_POLL,
      }),
    ).rejects.toBeInstanceOf(DataforseoAccountGateUnavailableError);
  });

  it("module singleton wires the real repository (the serp.ts dispatch path)", async () => {
    await expect(
      withDataforseoAccountRequest(ACCOUNT_B, "task_get", async () => "ok", {
        ...FAST_POLL,
        waitTimeoutMs: 5_000,
      }),
    ).resolves.toBe("ok");
  });
});
