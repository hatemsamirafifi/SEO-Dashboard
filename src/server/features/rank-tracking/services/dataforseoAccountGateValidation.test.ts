import { expect, it, vi } from "vitest";
import {
  createDataforseoAccountGate,
  DataforseoAccountGateBusyError,
  DataforseoAccountGateCancelledError,
} from "./dataforseoAccountGate";
const ACCOUNT_A = "a".repeat(64);

it.each(["deadline", "abort", "liveness error"] as const)(
  "releases the slot and prevents dispatch when pre-dispatch validation fails: %s",
  async (scenario) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    const failure = new Error("Run status storage unavailable");
    const isCancelled = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(failure);
    const store = {
      tryAcquireSlot: async () => {
        if (scenario === "deadline") now += 100;
        if (scenario === "abort") controller.abort();
        return { epoch: 1 };
      },
      tryCreateSlot: async () => null,
      releaseSlot: vi.fn(async () => true),
    };
    const dispatch = vi.fn(async () => "sent");
    try {
      const request = createDataforseoAccountGate(store).withRequest(
        ACCOUNT_A,
        "task_post",
        dispatch,
        {
          waitTimeoutMs: 50,
          pacingMs: 0,
          signal: controller.signal,
          ...(scenario === "liveness error" ? { isCancelled } : {}),
        },
      );
      if (scenario === "liveness error") {
        await expect(request).rejects.toBe(failure);
      } else {
        await expect(request).rejects.toBeInstanceOf(
          scenario === "deadline"
            ? DataforseoAccountGateBusyError
            : DataforseoAccountGateCancelledError,
        );
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.releaseSlot).toHaveBeenCalledOnce();
      expect(store.releaseSlot).toHaveBeenCalledWith({
        accountHash: ACCOUNT_A,
        epoch: 1,
        freeAtIso: new Date(now).toISOString(),
      });
    } finally {
      clock.mockRestore();
    }
  },
);
