import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCP_AUTH_CONTEXT_PROP, type ToolExtra } from "@/server/mcp/context";
import type * as SeoDataConfig from "@/server/lib/seo-data/config";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(async () => ({
    id: "proj-1",
    locationCode: 2840,
    languageCode: "en",
  })),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/seo-data/config", async (importOriginal) => {
  const actual = await importOriginal<typeof SeoDataConfig>();
  return {
    ...actual,
    getProviderFeatureFlags: vi.fn(async () => ({
      routerEnabled: true,
      serankingEnabled: true,
      dataforseoEnabled: false,
      gscEnabled: false,
      googleAdsEnabled: false,
      bingWebmasterEnabled: false,
      localCrawlerEnabled: true,
    })),
  };
});

import {
  searchLocalBusinessesTool,
  getLocalSerpResultsTool,
  getGoogleBusinessQuestionsTool,
} from "./dataforseo-research-tools";

describe("DataForSEO-dependent tools when DataForSEO is disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const authContext = {
    userId: "user-1",
    userEmail: "test@example.com",
    organizationId: "org-1",
    clientId: "client-1",
    scopes: ["mcp"],
    audience: "https://open-seo.test/mcp",
    subject: "user-1",
    baseUrl: "https://open-seo.test",
  };

  const dummyExtra: ToolExtra = {
    authInfo: {
      clientId: "client-1",
      scopes: ["mcp"],
      token: "test-token",
      extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
    },
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
  };

  it("searchLocalBusinessesTool returns clean unavailable message and never calls DataForSEO client", async () => {
    const res = await searchLocalBusinessesTool.handler(
      {
        projectId: "proj-1",
        near: { latitude: 40.7128, longitude: -74.006, radiusKm: 10 },
      },
      dummyExtra,
    );

    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    const c0 = res.content[0];
    expect(c0?.type === "text" ? c0.text : "").toContain(
      "DataForSEO, which is currently disabled",
    );
    expect(res.structuredContent).toMatchObject({
      businesses: [],
      unavailable: true,
      reason: "dataforseo_disabled",
    });
  });

  it("getLocalSerpResultsTool returns clean unavailable message and never calls DataForSEO client", async () => {
    const res = await getLocalSerpResultsTool.handler(
      {
        projectId: "proj-1",
        keyword: "pizza",
        near: { latitude: 40.7128, longitude: -74.006 },
      },
      dummyExtra,
    );

    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    const c0 = res.content[0];
    expect(c0?.type === "text" ? c0.text : "").toContain(
      "DataForSEO, which is currently disabled",
    );
  });

  it("getGoogleBusinessQuestionsTool returns clean unavailable message and never calls DataForSEO client", async () => {
    const res = await getGoogleBusinessQuestionsTool.handler(
      {
        projectId: "proj-1",
        keyword: "acme corp",
        near: { latitude: 40.7128, longitude: -74.006, radiusKm: 10 },
      },
      dummyExtra,
    );

    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    const c0 = res.content[0];
    expect(c0?.type === "text" ? c0.text : "").toContain(
      "DataForSEO, which is currently disabled",
    );
  });
});
