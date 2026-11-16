import { describe, expect, it, vi } from "vitest";
import server from "@/server";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_IDS,
  APPROVED_PILOT_PROJECT_ID,
} from "@/shared/rank-tracking";

const mockGetConfigById = vi.fn();
const mockGetProjectById = vi.fn();
const mockTriggerReadOnlySync = vi.fn();
const mockRunScheduledRankChecks = vi.fn();

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => vi.fn(async () => new Response("ok")),
  defaultStreamHandler: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
  DurableObject: class DurableObjectMock {
    public readonly isMock = true;
  },
  WorkflowEntrypoint: class WorkflowEntrypointMock {
    public readonly isMock = true;
  },
}));

vi.mock("@/server/workflows/SiteAuditWorkflow", () => ({
  SiteAuditWorkflow: class {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/workflows/RankCheckWorkflow", () => ({
  RankCheckWorkflow: class {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/workflows/AutopilotWorkflow", () => ({
  AutopilotWorkflow: class {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/features/onboarding/OnboardingChatAgent", () => ({
  OnboardingChatAgent: class {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/features/sam/SamChatAgent", () => ({
  SamChatAgent: class {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/lib/seranking/rateLimiter", () => ({
  SeRankingRateLimiter: class {
    public readonly isMock = true;
  },
}));

vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: (...args: unknown[]) => mockGetConfigById(...args),
    },
  }),
);

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
  },
}));

vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    triggerReadOnlySync: (...args: unknown[]) =>
      mockTriggerReadOnlySync(...args),
  },
}));

vi.mock(
  "@/server/features/rank-tracking/services/scheduledRankChecks",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runScheduledRankChecks: (...args: unknown[]) =>
        mockRunScheduledRankChecks(...args),
    };
  },
);

vi.mock("@/server/features/gsc/services/scheduledGscSync", () => ({
  runScheduledGscSync: vi.fn(async () => {}),
}));
vi.mock("@/server/features/ga4/services/scheduledGa4Sync", () => ({
  runScheduledGa4Sync: vi.fn(async () => {}),
}));
vi.mock("@/server/features/google-ads/services/scheduledGoogleAdsSync", () => ({
  runScheduledGoogleAdsSync: vi.fn(async () => {}),
}));
vi.mock(
  "@/server/features/intelligence/services/scheduledIntelligenceScan",
  () => ({
    runScheduledIntelligenceScan: vi.fn(async () => {}),
  }),
);
vi.mock("@/server/features/reports/services/scheduledReportRuns", () => ({
  runScheduledReportRuns: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  maybeSendSelfHostHeartbeat: vi.fn(async () => {}),
}));

function makeContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

describe("Operator Endpoint Security (/api/rank-tracking/read-only-sync)", () => {
  it("fails closed (404) when called in hosted production mode (AUTH_MODE=hosted)", async () => {
    const request = new Request(
      "https://app.openseo.so/api/rank-tracking/read-only-sync",
      {
        method: "POST",
      },
    );
    const env = {
      AUTH_MODE: "hosted",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(404);
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (404) when called in Cloudflare Access mode (AUTH_MODE=cloudflare_access)", async () => {
    const request = new Request(
      "https://preview.openseo.so/api/rank-tracking/read-only-sync",
      {
        method: "POST",
      },
    );
    const env = {
      AUTH_MODE: "cloudflare_access",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(404);
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (404) in local_noauth when ALLOW_LOCAL_PILOT_OPERATOR_SYNC is not 'true'", async () => {
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          "x-local-operator-secret": "test-secret-123",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
      // ALLOW_LOCAL_PILOT_OPERATOR_SYNC unset or false
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(404);
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (401) when operator secret is not configured in environment", async () => {
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          "x-local-operator-secret": "some-secret",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      // LOCAL_OPERATOR_SYNC_SECRET and LOCAL_SCHEDULER_SECRET unset
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Operator secret not configured");
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (401) when request is missing operator secret header", async () => {
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        // no auth header
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Unauthorized");
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (401) when request provides invalid operator secret header", async () => {
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          "x-local-operator-secret": "wrong-secret",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Unauthorized");
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("fails closed (403) when request host header is non-loopback LAN/public origin", async () => {
    const request = new Request(
      "http://192.168.1.100:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          host: "192.168.1.100:3101",
          "x-local-operator-secret": "test-secret-123",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Forbidden: non-loopback host");
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods with 405 Method Not Allowed in dev mode", async () => {
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "GET",
        headers: {
          "x-local-operator-secret": "test-secret-123",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(405);
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("ignores caller-supplied authorization fields and derives organization strictly from verified database records when secret is valid", async () => {
    mockGetConfigById.mockResolvedValueOnce({
      id: APPROVED_PILOT_CONFIG_ID,
      projectId: APPROVED_PILOT_PROJECT_ID,
      isActive: true,
    });
    mockGetProjectById.mockResolvedValueOnce({
      id: APPROVED_PILOT_PROJECT_ID,
      organizationId: "verified-db-org-999",
      archivedAt: null,
    });
    mockTriggerReadOnlySync.mockResolvedValueOnce({
      ok: true,
      runId: "run-dev-123",
      operationId: "op-dev-123",
    });

    // Attacker sends custom headers and body claiming to be another tenant
    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-local-operator-secret": "test-secret-123",
          "x-user-id": "attacker-user-id",
          "x-organization-id": "spoofed-victim-org",
        },
        body: JSON.stringify({
          userId: "attacker-user-id",
          organizationId: "spoofed-victim-org",
          projectId: "unauthorized-project",
        }),
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(200);

    // Verify triggerReadOnlySync was called with verified DB organization, NOT caller-supplied values
    expect(mockTriggerReadOnlySync).toHaveBeenCalledWith({
      configId: APPROVED_PILOT_CONFIG_ID,
      projectId: APPROVED_PILOT_PROJECT_ID,
      billingCustomer: {
        userId: "local-dev-operator",
        userEmail: "dev-operator@local",
        organizationId: "verified-db-org-999",
        projectId: APPROVED_PILOT_PROJECT_ID,
      },
      keywordIds: [...APPROVED_PILOT_KEYWORD_IDS],
    });
  });

  it("authenticates successfully with Authorization: Bearer <secret> header", async () => {
    mockGetConfigById.mockResolvedValueOnce({
      id: APPROVED_PILOT_CONFIG_ID,
      projectId: APPROVED_PILOT_PROJECT_ID,
      isActive: true,
    });
    mockGetProjectById.mockResolvedValueOnce({
      id: APPROVED_PILOT_PROJECT_ID,
      organizationId: "verified-db-org-999",
      archivedAt: null,
    });
    mockTriggerReadOnlySync.mockResolvedValueOnce({
      ok: true,
      runId: "run-dev-bearer",
      operationId: "op-dev-bearer",
    });

    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret-123",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(200);
    expect(mockTriggerReadOnlySync).toHaveBeenCalled();
  });

  it("returns 404 if pilot configuration is inactive or not found in database", async () => {
    mockGetConfigById.mockResolvedValueOnce(null);

    const request = new Request(
      "http://localhost:3101/api/rank-tracking/read-only-sync",
      {
        method: "POST",
        headers: {
          "x-local-operator-secret": "test-secret-123",
        },
      },
    );
    const env = {
      AUTH_MODE: "local_noauth",
      ALLOW_LOCAL_PILOT_OPERATOR_SYNC: "true",
      LOCAL_OPERATOR_SYNC_SECRET: "test-secret-123",
    } as unknown as Env;

    const res = await server.fetch(request, env, makeContext());
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(
      "Pilot configuration not found or inactive",
    );
    expect(mockTriggerReadOnlySync).not.toHaveBeenCalled();
  });

  it("preserves Cloudflare internal scheduled() handler independence from HTTP routes", async () => {
    const env = {
      AUTH_MODE: "hosted",
      SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "false",
    } as unknown as Env;

    const scheduledController = {
      cron: "*/15 * * * *",
      scheduledTime: Date.now(),
      noRetry: vi.fn(),
    } as unknown as ScheduledController;

    await server.scheduled(scheduledController, env, makeContext());
    expect(mockRunScheduledRankChecks).toHaveBeenCalledWith(env);
  });
});
