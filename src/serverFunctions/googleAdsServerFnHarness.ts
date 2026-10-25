import type { AsyncLocalStorage } from "node:async_hooks";

/* Test harness for TanStack Start server functions. In production the TanStack
 * Start compiler rewrites `createServerFn().handler(fn)` into
 * `createServerFn().handler(extractedFn, serverFn)`; without that transform
 * (e.g. under vitest) the runtime keeps `options.serverFn` undefined, only the
 * middleware chain runs and positive handler execution is unreachable. This
 * helper reproduces exactly the compiled runtime shape: a `.handler(fn)` call
 * behaves like the compiled `.handler(fn, fn)` provider-file output, so the
 * real middleware stack, the real validators and the real handler run on
 * every execution. No production code is touched and the auth boundary (global
 * ensure-user middleware, project middleware, validators) stays real.
 *
 * `./middleware` is imported lazily inside `executeServerFunction`: this file
 * is evaluated inside the `@tanstack/react-start` mock factory, so a static
 * middleware import would recursively re-enter that in-flight factory (a
 * circular async module dependency). Type-only imports from the module are
 * erased at build time and stay safe. */

type Chainable = {
  handler: (extracted: unknown, serverFn?: unknown) => unknown;
  middleware: (middleware: unknown) => Chainable;
  validator: (validator: unknown) => Chainable;
};

type RuntimeBuilder = {
  handler: (extracted: unknown, serverFn?: unknown) => unknown;
  middleware: (middleware: unknown) => unknown;
  validator: (validator: unknown) => unknown;
};

function isRuntimeBuilder(value: unknown): value is RuntimeBuilder {
  // The runtime builder is itself callable (Object.assign(fun, ...)), so it
  // can arrive as a function or an object.
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  return (
    "handler" in value &&
    typeof value.handler === "function" &&
    "middleware" in value &&
    typeof value.middleware === "function" &&
    "validator" in value &&
    typeof value.validator === "function"
  );
}

function isStartModule(
  value: unknown,
): value is { createServerFn: (options?: unknown) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "createServerFn" in value &&
    typeof value.createServerFn === "function"
  );
}

function compiledHandlerShape(builder: unknown): Chainable {
  if (!isRuntimeBuilder(builder)) {
    throw new Error("createServerFn did not return a chainable builder");
  }

  return {
    handler(extracted: unknown, serverFn?: unknown) {
      return builder.handler(extracted, serverFn ?? extracted);
    },
    middleware(middleware: unknown) {
      return compiledHandlerShape(builder.middleware(middleware));
    },
    validator(validator: unknown) {
      return compiledHandlerShape(builder.validator(validator));
    },
  };
}

/** Wraps the real createServerFn so every builder call returns a compiled
 *  handler shape. The factory result spreads the rest of the real module. */
export async function compiledCreateServerFnModule(actual: unknown) {
  if (!isStartModule(actual)) {
    throw new Error("TanStack Start module is missing createServerFn");
  }
  const createServerFn = actual.createServerFn;
  const compiledCreateServerFn = (options?: unknown) =>
    compiledHandlerShape(createServerFn(options));

  return { ...actual, createServerFn: compiledCreateServerFn };
}

type ServerFunction = {
  method: string;
  __executeServer(input: {
    method: "POST" | "GET";
    data: unknown;
    context: Record<string, never>;
  }): Promise<unknown>;
};

type StartStorage = AsyncLocalStorage<{
  getRouter: () => never;
  request: Request;
  startOptions: { functionMiddleware: Array<unknown> };
  contextAfterGlobalMiddlewares: Record<string, never>;
  executedRequestMiddlewares: Set<unknown>;
  handlerType: "serverFn";
}>;

/** Executes a server function through the real middleware stack and its
 *  validators inside the TanStack Start storage context. The answer is the
 *  middleware-chain envelope: { result, error, context }. */
export async function executeServerFunction(
  serverFunction: ServerFunction,
  data: unknown,
  method: "POST" | "GET" = "POST",
) {
  // The middleware module loads after the `@tanstack/react-start` mock
  // factory has resolved, so it sees the mock instead of re-entering it.
  const { globalServerFunctionMiddleware } = await import("./middleware");
  const storage = (
    globalThis as typeof globalThis & {
      [key: symbol]: StartStorage | undefined;
    }
  )[Symbol.for("tanstack-start:start-storage-context")];

  if (!storage) throw new Error("TanStack Start test context is unavailable");

  return storage.run(
    {
      getRouter: () => {
        throw new Error("Router is not used by this server-function test");
      },
      request: new Request("https://openseo.test/_server", {
        method: "POST",
      }),
      startOptions: { functionMiddleware: [...globalServerFunctionMiddleware] },
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      handlerType: "serverFn",
    },
    () => serverFunction.__executeServer({ method, data, context: {} }),
  );
}
