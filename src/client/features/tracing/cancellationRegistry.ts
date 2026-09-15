export type CancellationHandler = () => Promise<void> | void;

class CancellationRegistry {
  private handlers = new Map<string, CancellationHandler>();

  /**
   * Registers a cancellation handler for an operationId.
   * Returns an unregister function.
   */
  register(operationId: string, cancelFn: CancellationHandler): () => void {
    this.handlers.set(operationId, cancelFn);
    return () => {
      if (this.handlers.get(operationId) === cancelFn) {
        this.handlers.delete(operationId);
      }
    };
  }

  /**
   * Unregisters the cancellation handler for an operationId.
   */
  unregister(operationId: string): void {
    this.handlers.delete(operationId);
  }

  /**
   * Checks whether an operation has a registered cancellation handler.
   */
  isCancellable(operationId: string): boolean {
    return this.handlers.has(operationId);
  }

  /**
   * Invokes the registered cancellation handler for an operationId, if any.
   */
  async invoke(operationId: string): Promise<boolean> {
    const handler = this.handlers.get(operationId);
    if (!handler) return false;
    try {
      await handler();
      return true;
    } finally {
      this.handlers.delete(operationId);
    }
  }

  /**
   * Clears all registered handlers (useful for test resets).
   */
  clear(): void {
    this.handlers.clear();
  }
}

export const cancellationRegistry = new CancellationRegistry();

export function registerCancellation(
  operationId: string,
  cancelFn: CancellationHandler,
): () => void {
  return cancellationRegistry.register(operationId, cancelFn);
}

export function unregisterCancellation(operationId: string): void {
  cancellationRegistry.unregister(operationId);
}

export function isOperationCancellable(operationId: string): boolean {
  return cancellationRegistry.isCancellable(operationId);
}
