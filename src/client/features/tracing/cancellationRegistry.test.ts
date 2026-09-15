import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancellationRegistry,
  isOperationCancellable,
  registerCancellation,
  unregisterCancellation,
} from "./cancellationRegistry";

describe("cancellationRegistry", () => {
  beforeEach(() => {
    cancellationRegistry.clear();
  });

  it("registers a cancellation handler and reports isCancellable correctly", () => {
    const cancelFn = vi.fn();
    expect(isOperationCancellable("op-1")).toBe(false);

    const unregister = registerCancellation("op-1", cancelFn);
    expect(isOperationCancellable("op-1")).toBe(true);

    unregister();
    expect(isOperationCancellable("op-1")).toBe(false);
  });

  it("invokes the registered cancellation handler and removes it", async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    registerCancellation("op-2", cancelFn);

    expect(isOperationCancellable("op-2")).toBe(true);
    const invoked = await cancellationRegistry.invoke("op-2");

    expect(invoked).toBe(true);
    expect(cancelFn).toHaveBeenCalledTimes(1);
    expect(isOperationCancellable("op-2")).toBe(false);
  });

  it("returns false when invoking an unregistered operation", async () => {
    const invoked = await cancellationRegistry.invoke("non-existent");
    expect(invoked).toBe(false);
  });

  it("unregisters explicitly via unregisterCancellation", () => {
    const cancelFn = vi.fn();
    registerCancellation("op-3", cancelFn);
    expect(isOperationCancellable("op-3")).toBe(true);

    unregisterCancellation("op-3");
    expect(isOperationCancellable("op-3")).toBe(false);
  });

  it("handles errors during invocation gracefully and still cleans up", async () => {
    const error = new Error("Cancellation failed");
    const failingCancel = vi.fn().mockRejectedValue(error);

    registerCancellation("op-failing", failingCancel);
    await expect(cancellationRegistry.invoke("op-failing")).rejects.toThrow(
      "Cancellation failed",
    );

    expect(isOperationCancellable("op-failing")).toBe(false);
  });
});
