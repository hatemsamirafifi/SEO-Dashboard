import { afterEach, expect, it, vi } from "vitest";
import { GoogleAdsPlannerLimiter } from "./google-ads-planner-limiter";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState) {}
  },
}));

function storageForCustomer() {
  const values = new Map<string, number>();
  let pending = Promise.resolve();
  const storage = {
    transaction<T>(run: (tx: unknown) => Promise<T>) {
      const next = pending.then(() =>
        run({
          get: async (key: string) => values.get(key),
          put: async (key: string, value: number) => {
            values.set(key, value);
          },
        }),
      );
      pending = next.then(() => {});
      return next;
    },
  };
  // The test supplies only the storage transaction interface this DO uses.
  return { storage } as unknown as DurableObjectState;
}

function reserve(limiter: GoogleAdsPlannerLimiter) {
  return limiter.fetch(
    new Request("https://planner-limiter/reserve", { method: "POST" }),
  );
}

afterEach(() => vi.useRealTimers());

it("shares a persisted cooldown for each customer independently", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const customer = storageForCustomer();
  const limiter = new GoogleAdsPlannerLimiter(customer, {});
  const otherCustomer = new GoogleAdsPlannerLimiter(storageForCustomer(), {});
  const outcomes = await Promise.all([
    reserve(limiter),
    reserve(limiter),
    reserve(otherCustomer),
  ]);
  expect(outcomes.map((response) => response.status)).toEqual([204, 429, 204]);

  const restarted = new GoogleAdsPlannerLimiter(customer, {});
  vi.setSystemTime(59_999);
  expect((await reserve(restarted)).status).toBe(429);
  vi.setSystemTime(60_000);
  expect((await reserve(restarted)).status).toBe(204);
});
