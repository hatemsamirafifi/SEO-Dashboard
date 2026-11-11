import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

// The account coordination gate has its own dedicated test file (against a
// real scratch SQLite store). Here it is replaced with a recording
// passthrough so these wire-format tests stay isolated from the DB stack.
const gateMocks = vi.hoisted(() => ({
  withRequest: vi.fn(
    (
      _accountHash: string,
      _kind: string,
      fn: () => Promise<unknown>,
      _options?: unknown,
    ) => fn(),
  ),
}));

vi.mock(
  "@/server/features/rank-tracking/services/dataforseoAccountGate",
  () => ({ withDataforseoAccountRequest: gateMocks.withRequest }),
);

const settingsMocks = vi.hoisted(() => ({
  resolveEffectiveDataforseoConfig: vi.fn(),
}));

vi.mock(
  "@/server/features/settings/services/DataforseoSettingsService",
  () => ({
    resolveEffectiveDataforseoConfig:
      settingsMocks.resolveEffectiveDataforseoConfig,
  }),
);

import { runWithDataforseoAccountContext } from "@/server/lib/dataforseo/accountContext";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";
import {
  fetchRankCheckTaskResult,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";

function parseDataforseoRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

/** SHA-256 hex of a string, matching core.ts's account identifier. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function gateCall(index = 0) {
  const call = gateMocks.withRequest.mock.calls[index];
  if (!call) throw new Error(`No gate call at index ${index}`);
  return { accountHash: call[0], kind: call[1], options: call[3] };
}

const NOT_CONFIGURED = {
  enabled: false,
  circuitBreakerEnabled: true,
  maxRetries: 2,
  source: "none" as const,
  configured: false,
  priority: 1,
};

/** Reset the shared hoisted mocks to their working defaults. */
function resetMocks() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gateMocks.withRequest.mockImplementation((_hash, _kind, fn) => fn());
  gateMocks.withRequest.mockClear();
  vi.mocked(getRequiredEnvValue).mockImplementation(async () => "test-api-key");
  vi.mocked(getOptionalEnvValue).mockImplementation(async () => undefined);
  settingsMocks.resolveEffectiveDataforseoConfig.mockReset();
  settingsMocks.resolveEffectiveDataforseoConfig.mockResolvedValue(
    NOT_CONFIGURED,
  );
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
}

describe("rank check task queue", () => {
  beforeEach(resetMocks);

  it.each([500, 503])(
    "does not retry a paid task_post after HTTP %i",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json(
            { status_code: 50000, status_message: "Temporarily unavailable" },
            { status },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        postRankCheckTasks({
          tasks: [{ keyword: "alpha", keywordId: "kw-1", device: "desktop" }],
          locationCode: 2840,
          languageCode: "en",
          depth: 10,
          targetDomain: "example.com",
        }),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("can retry a free task_get after a temporary HTTP failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status_code: 50000 }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ status_code: 20000, tasks: [{ status_code: 40602 }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchRankCheckTaskResult({
        taskId: "task-id",
        keywordId: "kw-1",
        keyword: "alpha",
        targetDomain: "example.com",
      }),
    ).resolves.toEqual({ status: "pending" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:desktop" },
          },
          {
            id: "task-b",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:mobile" },
          },
          {
            id: "task-c",
            status_code: 40006,
            status_message: "Task Limit Exceeded",
            cost: 0.0006,
            data: { tag: "kw-2:desktop" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === "string" || url instanceof URL
          ? url.toString()
          : url.url,
      ),
    ).toEqual(["https://api.dataforseo.com/v3/serp/google/organic/task_post"]);

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing, and posts at NORMAL queue priority (1) — never
    // priority_high, which DataForSEO bills at a premium.
    const bodies = fetchMock.mock.calls.map(([url, init]) => {
      void url;
      return parseDataforseoRequestBody(init);
    });
    expect(bodies[0]).toMatchObject([
      expect.objectContaining({
        stop_crawl_on_match: [
          { match_value: "example.com", match_type: "with_subdomains" },
        ],
        find_targets_in: ["organic"],
        priority: 1,
      }),
      expect.objectContaining({ priority: 1 }),
      expect.objectContaining({ priority: 1 }),
    ]);

    // The paid task_post goes through the account coordination gate.
    expect(gateMocks.withRequest).toHaveBeenCalledTimes(1);
    expect(gateCall().kind).toBe("task_post");

    expect(result.data.posted).toEqual([
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
      },
    ]);
    // The rejected entry is returned with its reason so the workflow can
    // record per-keyword diagnostics (it is never resubmitted to Live).
    expect(result.data.rejected).toEqual([
      {
        task: { keyword: "beta", keywordId: "kw-2", device: "desktop" },
        statusCode: 40006,
        statusMessage: "Task Limit Exceeded",
      },
    ]);
    // The rejected entry's cost is still metered: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  });

  it("reports a queued task still in progress as pending", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({ status: "pending" });
    // Free task_get dispatches still go through the account gate.
    expect(gateCall().kind).toBe("task_get");
  });

  it("parses a completed queued task into a rank check result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [
              {
                items: [
                  {
                    type: "organic",
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: "www.example.com",
                    url: "https://www.example.com/page",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({
      status: "completed",
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        url: "https://www.example.com/page",
        serpFeatures: ["organic"],
        // Spec 019: the organic results the provider already returned are
        // captured for the clustering read.
        organicResults: [
          {
            position: 3,
            title: null,
            url: "https://www.example.com/page",
            domain: "www.example.com",
          },
        ],
      },
    });
  });
});

describe("rank check dispatch account binding", () => {
  beforeEach(resetMocks);

  it("collects against the posting account: project settings credentials are used for task_get", async () => {
    // The metered task_post ran under this scope's project-level override.
    settingsMocks.resolveEffectiveDataforseoConfig.mockResolvedValue({
      enabled: true,
      circuitBreakerEnabled: true,
      maxRetries: 2,
      login: "project-login@example.com",
      password: "project-password",
      source: "project" as const,
      configured: true,
      priority: 1,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runWithDataforseoAccountContext(
      { organizationId: "org_1", projectId: "proj_1" },
      () =>
        fetchRankCheckTaskResult({
          taskId: "task-a",
          keywordId: "kw-1",
          keyword: "alpha",
          targetDomain: "example.com",
        }),
    );

    // The gate coordinated the POST account (settings login), and the
    // dispatch used the settings credentials — not environment credentials.
    expect(gateCall().accountHash).toBe(
      await sha256Hex("project-login@example.com"),
    );
    const auth = fetchMock.mock.calls[0]?.[1]?.headers;
    const header =
      typeof Headers !== "undefined" && auth instanceof Headers
        ? auth.get("Authorization")
        : undefined;
    expect(header).toBe(
      `Basic ${Buffer.from("project-login@example.com:project-password").toString("base64")}`,
    );
    // Collection stays free: task_get never enters the metered client.
    expect(gateCall().kind).toBe("task_get");
  });

  it("falls back to the environment account when the scope has no settings credentials", async () => {
    settingsMocks.resolveEffectiveDataforseoConfig.mockResolvedValue(
      NOT_CONFIGURED,
    );
    // No legacy API key: the credential resolution falls through to the
    // DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD environment pair.
    vi.mocked(getRequiredEnvValue).mockResolvedValue("");
    process.env.DATAFORSEO_LOGIN = "env-login@example.com";
    process.env.DATAFORSEO_PASSWORD = "env-password";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runWithDataforseoAccountContext(
      { organizationId: "org_1", projectId: "proj_1" },
      () =>
        fetchRankCheckTaskResult({
          taskId: "task-a",
          keywordId: "kw-1",
          keyword: "alpha",
          targetDomain: "example.com",
        }),
    );

    expect(gateCall().accountHash).toBe(
      await sha256Hex("env-login@example.com"),
    );
  });

  it("threads the cancellation callback into the gated dispatch", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const isCancelled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);

    await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
      isCancelled,
    });

    expect(gateCall().options).toEqual({ isCancelled });
  });

  it("derives the same account hash for a legacy base64 key as for settings with that login", async () => {
    // The raw DATAFORSEO_API_KEY path (no context): a base64 login:password
    // key must coordinate on the LOGIN's hash — the same account as settings
    // credentials with that login, even with a different password.
    const legacyKey = Buffer.from(
      "shared-login@example.com:legacy-password",
    ).toString("base64");
    vi.mocked(getRequiredEnvValue).mockResolvedValue(legacyKey);

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(gateCall().accountHash).toBe(
      await sha256Hex("shared-login@example.com"),
    );
  });
});
