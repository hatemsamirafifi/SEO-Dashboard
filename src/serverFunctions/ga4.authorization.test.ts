import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://openseo.test/_server", { method: "POST" }),
}));

vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUser,
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.projectLookup,
  },
}));

vi.mock("@/server/features/ga4/services/Ga4Service", () => ({
  Ga4Service: {
    getConnection: vi.fn(),
    userHasGrant: vi.fn(),
    listPropertiesForUser: vi.fn(),
    setProperty: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock("@/server/features/gsc/selfHostedOAuth", () => ({
  createSelfHostedGa4AuthorizationUrl: vi.fn(),
}));

vi.mock("@/server/features/gsc/oauth-config", () => ({
  hasSelfHostedGscConfig: vi.fn(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("@/server/mcp/public-origin", () => ({
  getPublicOrigin: vi.fn(),
}));

import {
  disconnectGa4,
  getGa4Connection,
  listGa4Properties,
  setGa4Property,
  startSelfHostedGa4Link,
} from "./ga4";
import { globalServerFunctionMiddleware } from "./middleware";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, string>;
    context: Record<string, never>;
  }): Promise<unknown>;
};

type StartStorage = AsyncLocalStorage<{
  getRouter: () => never;
  request: Request;
  startOptions: { functionMiddleware: typeof globalServerFunctionMiddleware };
  contextAfterGlobalMiddlewares: Record<string, never>;
  executedRequestMiddlewares: Set<unknown>;
  handlerType: "serverFn";
}>;

async function executeServerFunction(
  serverFunction: ServerFunction,
  data: Record<string, string>,
) {
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
      startOptions: { functionMiddleware: globalServerFunctionMiddleware },
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      handlerType: "serverFn",
    },
    () => serverFunction.__executeServer({ method: "POST", data, context: {} }),
  );
}

describe("GA4 server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
  });

  it.each([
    ["getGa4Connection", getGa4Connection, { projectId: "other-project" }],
    ["listGa4Properties", listGa4Properties, { projectId: "other-project" }],
    [
      "setGa4Property",
      setGa4Property,
      {
        projectId: "other-project",
        accountId: "google-account",
        propertyId: "property-1",
      },
    ],
    ["disconnectGa4", disconnectGa4, { projectId: "other-project" }],
    [
      "startSelfHostedGa4Link",
      startSelfHostedGa4Link,
      {
        projectId: "other-project",
        callbackURL: "/p/other-project/settings",
      },
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    },
  );
});
