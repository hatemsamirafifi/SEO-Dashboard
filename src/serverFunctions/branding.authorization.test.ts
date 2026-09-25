import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  getOrganizationBranding: vi.fn(),
  setOrganizationBranding: vi.fn(),
  getClientProfile: vi.fn(),
  setClientProfile: vi.fn(),
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

vi.mock("@/server/features/reports/services/BrandingService", () => ({
  BrandingService: {
    getOrganizationBranding: mocks.getOrganizationBranding,
    setOrganizationBranding: mocks.setOrganizationBranding,
    getClientProfile: mocks.getClientProfile,
    setClientProfile: mocks.setClientProfile,
  },
}));

import {
  getClientProfile,
  setClientProfile,
} from "./branding";
import { globalServerFunctionMiddleware } from "./middleware";
import {
  getClientProfileSchema,
  setClientProfileSchema,
  setOrganizationBrandingSchema,
} from "@/types/schemas/branding";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, unknown>;
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
  data: Record<string, unknown>,
) {
  const storage = (
    globalThis as typeof globalThis & {
      [key: symbol]: StartStorage | undefined;
    }
  )[Symbol.for("tanstack-start:start-storage-context")];

  if (!storage) throw new Error("TanStack Start context is unavailable");

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

describe("branding server-function authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.getOrganizationBranding.mockReset();
    mocks.setOrganizationBranding.mockReset();
    mocks.getClientProfile.mockReset();
    mocks.setClientProfile.mockReset();
  });

  it.each([
    [
      "getClientProfile",
      getClientProfile,
      { projectId: "other-project" },
      "getClientProfile",
    ],
    [
      "setClientProfile",
      setClientProfile,
      { projectId: "other-project", clientName: "Client" },
      "setClientProfile",
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data, mockName) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
      expect(
        mocks[mockName as "getClientProfile" | "setClientProfile"],
      ).not.toHaveBeenCalled();
    },
  );

  it("never accepts an organization id from client input", () => {
    // Org-only functions are unexecutable in this harness (Start echoes the
    // input context without running handlers — verified against production
    // getProjects), so scoping is asserted structurally: no branding schema
    // carries organizationId, and handlers thread context.organizationId
    // from the session. Service-level tests key every row by org.
    for (const schema of [
      setOrganizationBrandingSchema,
      setClientProfileSchema,
      getClientProfileSchema,
    ]) {
      expect("organizationId" in schema.shape).toBe(false);
    }
  });
});
