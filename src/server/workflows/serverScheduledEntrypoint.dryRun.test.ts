import type { Client } from "@libsql/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_DESKTOP_ENGINE_ID,
  APPROVED_PILOT_KEYWORD_ID,
  APPROVED_PILOT_MOBILE_ENGINE_ID,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_REMOTE_KEYWORD_ID,
  APPROVED_PILOT_REMOTE_SITE_ID,
  APPROVED_PILOT_TARGET_IDS,
} from "@/shared/rank-tracking";

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

const testState = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  workflowPromises: [] as Promise<unknown>[],
}));

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => vi.fn(async () => new Response("ok")),
  defaultStreamHandler: vi.fn(),
}));

vi.mock("@/server/lib/seranking/rateLimiter", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRateLimiterCoordinator: () => ({
      acquire: async () => {},
    }),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: testState.env,
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    testState.workflowPromises.push(promise);
  }),
  DurableObject: class DurableObjectMock {
    public readonly isMock = true;
  },
  WorkflowEntrypoint: class WorkflowEntrypointMock {
    public readonly ctx: unknown;
    public readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@/server/workflows/SiteAuditWorkflow", () => ({
  SiteAuditWorkflow: class SiteAuditWorkflowMock {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/workflows/AutopilotWorkflow", () => ({
  AutopilotWorkflow: class AutopilotWorkflowMock {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/features/onboarding/OnboardingChatAgent", () => ({
  OnboardingChatAgent: class OnboardingChatAgentMock {
    public readonly isMock = true;
  },
}));
vi.mock("@/server/features/sam/SamChatAgent", () => ({
  SamChatAgent: class SamChatAgentMock {
    public readonly isMock = true;
  },
}));

vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(),
}));

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
vi.mock("@/server/billing/autumn-webhook", () => ({
  AUTUMN_WEBHOOK_PATH: "/api/autumn/webhook",
  handleAutumnWebhookRequest: vi.fn(),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  maybeSendSelfHostHeartbeat: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@/server/features/settings/services/SeRankingSettingsService", () => ({
  resolveEffectiveSeRankingConfig: vi.fn(async () => ({
    provider: "seranking" as const,
    enabled: true,
    circuitBreakerEnabled: true,
    maxRetries: 1,
    configured: true,
    apiKey: "dry-run-seranking-key",
    baseUrl: "https://api.seranking.com/v1",
    source: "environment" as const,
    priority: 1,
  })),
  resolveEffectiveSeRankingClientConfig: vi.fn(async () => ({
    apiKey: "dry-run-seranking-key",
    baseUrl: "https://api.seranking.com/v1",
    maxRetries: 1,
  })),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(async () => false),
  getOptionalEnvValue: vi.fn((key: string) => process.env[key]),
  getRequiredEnvValue: vi.fn((key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing env ${key}`);
    return value;
  }),
  resolveServerAuthMode: vi.fn(async () => "local_noauth"),
  resolveRuntimeEnv: vi.fn(async () => process.env),
}));

vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/schema");
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  database.client = client;
  database.db = db;
  return {
    db,
    withPgClient: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
    if (!database.db) throw new Error("Test DB not initialized");
    for (const stmt of build(database.db)) await stmt;
  },
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test DB not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

const serverModule = await import("@/server");
const { RankCheckWorkflow } = serverModule;
const { RankTrackingService } =
  await import("@/server/features/rank-tracking/services/RankTrackingService");
const { computeAccountFingerprint } =
  await import("@/server/features/rank-tracking/services/SeRankingProjectSyncService");

const ORG_ID = "delegated-local-admin";
const PROJECT_BINDING_ID = "0f24afa1-7728-4128-8bcc-b21e4235760b";
const DESKTOP_TARGET_ID = APPROVED_PILOT_TARGET_IDS[0];
const MOBILE_TARGET_ID = APPROVED_PILOT_TARGET_IDS[1];
const NON_PILOT_KEYWORD_ID = "00000000-0000-0000-0000-000000000099";
const APPROVED_KEYWORD_TEXT = "إنشاء ملاعب متعددة الأغراض";
const NON_PILOT_KEYWORD_TEXT = "عشب ملاعب غير مصرح";

interface RecordedFetch {
  method: string;
  url: string;
}

function createStepMock() {
  return {
    do: async <T>(
      _name: string,
      optsOrFn: unknown,
      maybeFn?: () => Promise<T>,
    ): Promise<T> => {
      const fn =
        typeof optsOrFn === "function"
          ? (optsOrFn as () => Promise<T>)
          : maybeFn!;
      return fn();
    },
    sleep: async () => {},
  };
}

function createExecutionContextMock(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      testState.workflowPromises.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  };
}

describe("Scheduled Worker Entrypoint Dry-Run (server.default.scheduled -> RankCheckWorkflow -> SQLite)", () => {
  const originalFetch = globalThis.fetch;
  let recordedRequests: RecordedFetch[] = [];
  let availableDates: string[] = [];
  let positionsByEngine: Record<
    string,
    Array<{ date: string; pos: number; url: string }>
  > = {};

  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");

    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(
      `CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL, name text, domain text, archived_at text)`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_configs (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        domain text NOT NULL,
        location_code integer DEFAULT 2840 NOT NULL,
        language_code text DEFAULT 'en' NOT NULL,
        devices text DEFAULT 'both' NOT NULL,
        serp_depth integer DEFAULT 50 NOT NULL,
        schedule_interval text DEFAULT 'weekly' NOT NULL,
        location_name text,
        is_active integer DEFAULT 1 NOT NULL,
        last_checked_at text,
        next_check_at text,
        last_skip_reason text,
        created_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_keywords (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        keyword text NOT NULL,
        search_volume integer,
        keyword_difficulty integer,
        cpc real,
        metrics_fetched_at text,
        created_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_targets (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        local_project_id text NOT NULL,
        tracking_config_id text,
        search_engine text DEFAULT 'google' NOT NULL,
        country_code text NOT NULL,
        region_code text,
        city_name text,
        language_code text DEFAULT 'en' NOT NULL,
        device text NOT NULL,
        enabled integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_keyword_targets (
        id text PRIMARY KEY,
        tracking_keyword_id text NOT NULL,
        tracking_target_id text NOT NULL,
        enabled integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_account_bindings (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        account_fingerprint text NOT NULL,
        credential_version integer DEFAULT 1 NOT NULL,
        status text DEFAULT 'active' NOT NULL,
        last_validated_at text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_project_bindings (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        local_project_id text NOT NULL,
        provider_account_binding_id text NOT NULL,
        remote_site_id integer,
        status text DEFAULT 'connected' NOT NULL,
        last_successful_sync text,
        error_message text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_engine_bindings (
        id text PRIMARY KEY,
        project_binding_id text NOT NULL,
        tracking_target_id text NOT NULL,
        remote_site_engine_id integer NOT NULL,
        remote_search_engine_id integer NOT NULL,
        remote_region_id integer,
        remote_region_name text,
        remote_language_code text,
        sync_status text DEFAULT 'connected' NOT NULL,
        last_successful_sync text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_keyword_mappings (
        id text PRIMARY KEY,
        project_binding_id text NOT NULL,
        tracking_keyword_id text NOT NULL,
        remote_keyword_id text NOT NULL,
        status text DEFAULT 'synced' NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_check_runs (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        project_id text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        keywords_total integer DEFAULT 0 NOT NULL,
        keywords_checked integer DEFAULT 0 NOT NULL,
        trigger text DEFAULT 'manual' NOT NULL,
        is_subset_run integer DEFAULT 0 NOT NULL,
        error_message text,
        started_at text DEFAULT (current_timestamp) NOT NULL,
        completed_at text
      )`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX se_ranking_project_bindings_project_account_idx ON se_ranking_project_bindings (local_project_id, provider_account_binding_id)`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX se_ranking_engine_bindings_binding_target_idx ON se_ranking_engine_bindings (project_binding_id, tracking_target_id)`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX se_ranking_keyword_mappings_binding_kw_idx ON se_ranking_keyword_mappings (project_binding_id, tracking_keyword_id)`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX rank_check_runs_one_active_per_config_idx ON rank_check_runs (config_id) WHERE status IN ('pending', 'running')`,
    );
    await client.execute(`
      CREATE TABLE rank_snapshots (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        run_id text NOT NULL,
        project_id text,
        config_id text,
        tracking_keyword_id text NOT NULL,
        keyword text NOT NULL,
        search_engine text DEFAULT 'google' NOT NULL,
        search_type text DEFAULT 'organic' NOT NULL,
        location text,
        language text,
        device text NOT NULL,
        position integer,
        previous_position integer,
        ranking_status text,
        url text,
        serp_features text,
        provider text DEFAULT 'dataforseo' NOT NULL,
        provider_status text,
        provider_status_code integer,
        error_message text,
        completion_confidence text,
        observation_source text,
        tracking_target_id text,
        country_code text,
        city_name text,
        checked_at text DEFAULT (current_timestamp) NOT NULL,
        checked_date text,
        imported_at text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_run_target_kw_device_idx ON rank_snapshots (run_id, tracking_target_id, tracking_keyword_id, device, checked_date) WHERE tracking_target_id IS NOT NULL`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_legacy_run_kw_device_idx ON rank_snapshots (run_id, tracking_keyword_id, device) WHERE tracking_target_id IS NULL`,
    );
    await client.execute(
      `CREATE TABLE rank_provider_calls (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        run_id text NOT NULL,
        tracking_keyword_id text NOT NULL,
        device text NOT NULL,
        provider text NOT NULL,
        endpoint text NOT NULL,
        status text NOT NULL,
        http_status integer,
        error_code text,
        skip_reason text,
        circuit_reason text,
        circuit_opened_at text,
        circuit_expires_at text,
        attempt integer,
        max_retries integer,
        retryable integer,
        retry_after_ms integer,
        duration_ms integer NOT NULL,
        result_count integer,
        requested_depth integer DEFAULT 0 NOT NULL,
        inspected_depth integer,
        pages_requested integer DEFAULT 0 NOT NULL,
        result_completeness text DEFAULT 'not_applicable' NOT NULL,
        dispatched integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    process.env.DATAFORSEO_ENABLED = "false";
    recordedRequests = [];
    testState.workflowPromises = [];
    availableDates = ["2026-11-14"];
    positionsByEngine = {
      [String(APPROVED_PILOT_DESKTOP_ENGINE_ID)]: [
        {
          date: "2026-11-14",
          pos: 86,
          url: "https://sports-ms.com/multi-purpose",
        },
        {
          date: "2026-11-18",
          pos: 72,
          url: "https://sports-ms.com/multi-purpose",
        },
      ],
      [String(APPROVED_PILOT_MOBILE_ENGINE_ID)]: [
        {
          date: "2026-11-14",
          pos: 47,
          url: "https://sports-ms.com/multi-purpose",
        },
        {
          date: "2026-11-18",
          pos: 41,
          url: "https://sports-ms.com/multi-purpose",
        },
      ],
    };

    const client = database.client!;
    await client.execute(`DELETE FROM rank_provider_calls`);
    await client.execute(`DELETE FROM rank_snapshots`);
    await client.execute(`DELETE FROM rank_check_runs`);
    await client.execute(`DELETE FROM se_ranking_keyword_mappings`);
    await client.execute(`DELETE FROM se_ranking_engine_bindings`);
    await client.execute(`DELETE FROM se_ranking_project_bindings`);
    await client.execute(`DELETE FROM se_ranking_account_bindings`);
    await client.execute(`DELETE FROM rank_tracking_keyword_targets`);
    await client.execute(`DELETE FROM rank_tracking_targets`);
    await client.execute(`DELETE FROM rank_tracking_keywords`);
    await client.execute(`DELETE FROM rank_tracking_configs`);
    await client.execute(`DELETE FROM projects`);
    await client.execute(`DELETE FROM organization`);

    await client.execute(`INSERT INTO organization (id) VALUES ('${ORG_ID}')`);
    await client.execute(
      `INSERT INTO projects (id, organization_id, name, domain) VALUES ('${APPROVED_PILOT_PROJECT_ID}', '${ORG_ID}', 'sports-ms.com', 'sports-ms.com')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_configs (id, project_id, domain, location_code, language_code, devices, serp_depth, schedule_interval, location_name, is_active, last_checked_at, next_check_at)
       VALUES ('${APPROVED_PILOT_CONFIG_ID}', '${APPROVED_PILOT_PROJECT_ID}', 'sports-ms.com', 2818, 'ar', 'both', 100, 'weekly', 'Egypt', 1, '2026-11-14T15:13:40.578Z', '2026-11-18T07:24:00.000Z')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_keywords (id, config_id, keyword) VALUES
       ('${APPROVED_PILOT_KEYWORD_ID}', '${APPROVED_PILOT_CONFIG_ID}', '${APPROVED_KEYWORD_TEXT}'),
       ('${NON_PILOT_KEYWORD_ID}', '${APPROVED_PILOT_CONFIG_ID}', '${NON_PILOT_KEYWORD_TEXT}')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, search_engine, country_code, language_code, device, enabled) VALUES
       ('${DESKTOP_TARGET_ID}', '${ORG_ID}', '${APPROVED_PILOT_PROJECT_ID}', '${APPROVED_PILOT_CONFIG_ID}', 'google', 'EG', 'ar', 'desktop', 1),
       ('${MOBILE_TARGET_ID}', '${ORG_ID}', '${APPROVED_PILOT_PROJECT_ID}', '${APPROVED_PILOT_CONFIG_ID}', 'google', 'EG', 'ar', 'mobile', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_keyword_targets (id, tracking_keyword_id, tracking_target_id, enabled) VALUES
       ('kt-1', '${APPROVED_PILOT_KEYWORD_ID}', '${DESKTOP_TARGET_ID}', 1),
       ('kt-2', '${APPROVED_PILOT_KEYWORD_ID}', '${MOBILE_TARGET_ID}', 1),
       ('kt-3', '${NON_PILOT_KEYWORD_ID}', '${DESKTOP_TARGET_ID}', 1),
       ('kt-4', '${NON_PILOT_KEYWORD_ID}', '${MOBILE_TARGET_ID}', 1)`,
    );
    const dryRunFingerprint = computeAccountFingerprint(
      "dry-run-seranking-key",
    );
    await client.execute(
      `INSERT INTO se_ranking_account_bindings (id, organization_id, account_fingerprint, status)
       VALUES ('acc-1', '${ORG_ID}', '${dryRunFingerprint}', 'active')`,
    );
    await client.execute(
      `INSERT INTO se_ranking_project_bindings (id, organization_id, local_project_id, provider_account_binding_id, remote_site_id, status)
       VALUES ('${PROJECT_BINDING_ID}', '${ORG_ID}', '${APPROVED_PILOT_PROJECT_ID}', 'acc-1', ${APPROVED_PILOT_REMOTE_SITE_ID}, 'connected')`,
    );
    await client.execute(
      `INSERT INTO se_ranking_engine_bindings (id, project_binding_id, tracking_target_id, remote_site_engine_id, remote_search_engine_id, sync_status) VALUES
       ('eng-1', '${PROJECT_BINDING_ID}', '${DESKTOP_TARGET_ID}', ${APPROVED_PILOT_DESKTOP_ENGINE_ID}, 1, 'connected'),
       ('eng-2', '${PROJECT_BINDING_ID}', '${MOBILE_TARGET_ID}', ${APPROVED_PILOT_MOBILE_ENGINE_ID}, 2, 'connected')`,
    );
    await client.execute(
      `INSERT INTO se_ranking_keyword_mappings (id, project_binding_id, tracking_keyword_id, remote_keyword_id, status) VALUES
       ('map-1', '${PROJECT_BINDING_ID}', '${APPROVED_PILOT_KEYWORD_ID}', '${APPROVED_PILOT_REMOTE_KEYWORD_ID}', 'synced'),
       ('map-2', '${PROJECT_BINDING_ID}', '${NON_PILOT_KEYWORD_ID}', '99999999', 'synced')`,
    );

    const activeWorkflowRuns = new Map<
      string,
      { status: string; promise: Promise<unknown> }
    >();

    testState.env.RANK_CHECK_WORKFLOW = {
      create: async (opts: { id: string; params: unknown }) => {
        const wf = new RankCheckWorkflow(
          createExecutionContextMock(),
          testState.env as unknown as Env,
        );
        const step = createStepMock();
        const runPromise = wf.run(
          { payload: opts.params } as never,
          step as never,
        );
        activeWorkflowRuns.set(opts.id, {
          status: "running",
          promise: runPromise,
        });
        testState.workflowPromises.push(runPromise);
        await runPromise;
        activeWorkflowRuns.set(opts.id, {
          status: "complete",
          promise: runPromise,
        });
        return { id: opts.id };
      },
      get: async (id: string) => ({
        status: async () => ({
          status: activeWorkflowRuns.get(id)?.status ?? "unknown",
        }),
        terminate: async () => {},
      }),
    };

    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.href;
        const method = (init?.method ?? "GET").toUpperCase();
        recordedRequests.push({ method, url });

        // Hard safety assertion inside test boundary: NEVER allow non-GET or non-SE-Ranking requests
        if (method !== "GET") {
          throw new Error(
            `FORBIDDEN NON-GET FETCH ATTEMPTED IN DRY-RUN: ${method} ${url}`,
          );
        }
        if (
          !url.startsWith("https://api.seranking.com/v1/project-management/")
        ) {
          throw new Error(`FORBIDDEN EXTERNAL PROVIDER URL IN DRY-RUN: ${url}`);
        }

        const parsed = new URL(url);
        if (parsed.pathname === "/v1/project-management/sites") {
          return new Response(
            JSON.stringify([
              {
                id: APPROVED_PILOT_REMOTE_SITE_ID,
                name: "https://sports-ms.com",
                title: "sports-ms.com",
                url: "https://sports-ms.com",
                check_freq: "check_daily",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (parsed.pathname.endsWith("/sites/search-engines")) {
          return new Response(
            JSON.stringify([
              {
                site_engine_id: APPROVED_PILOT_DESKTOP_ENGINE_ID,
                search_engine_id: 1,
              },
              {
                site_engine_id: APPROVED_PILOT_MOBILE_ENGINE_ID,
                search_engine_id: 2,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (parsed.pathname === "/v1/project-management/keywords") {
          return new Response(
            JSON.stringify([
              {
                id: Number(APPROVED_PILOT_REMOTE_KEYWORD_ID),
                name: APPROVED_KEYWORD_TEXT,
                site_engine_ids: [
                  APPROVED_PILOT_DESKTOP_ENGINE_ID,
                  APPROVED_PILOT_MOBILE_ENGINE_ID,
                ],
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (parsed.pathname.endsWith("/sites/check-dates")) {
          return new Response(JSON.stringify(availableDates), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (parsed.pathname.endsWith("/sites/positions")) {
          const siteEngineId = parsed.searchParams.get("site_engine_id") ?? "";
          const dateFrom = parsed.searchParams.get("date_from") ?? "0000-00-00";
          const dateTo = parsed.searchParams.get("date_to") ?? "9999-99-99";
          const enginePositions = (
            positionsByEngine[siteEngineId] ?? []
          ).filter((p) => p.date >= dateFrom && p.date <= dateTo);

          // Include both approved pilot keyword and an unauthorized extra keyword in provider response
          // to prove pre-persistence allowlist filtering keeps only 24606031.
          const body = [
            {
              id: Number(APPROVED_PILOT_REMOTE_KEYWORD_ID),
              name: APPROVED_KEYWORD_TEXT,
              positions: enginePositions.map((p) => ({
                date: p.date,
                pos: p.pos,
                change: 0,
                landing_pages: [{ url: p.url, date: p.date }],
              })),
            },
            {
              id: 99999999,
              name: NON_PILOT_KEYWORD_TEXT,
              positions: enginePositions.map((p) => ({
                date: p.date,
                pos: 3,
                change: 0,
                landing_pages: [
                  { url: "https://sports-ms.com/other", date: p.date },
                ],
              })),
            },
          ];

          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error(`Unexpected SE Ranking path: ${parsed.pathname}`);
      },
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  async function invokeWorkerScheduled() {
    await serverModule.default.scheduled(
      {
        cron: "*/15 * * * *",
        scheduledTime: Date.now(),
        noRetry: vi.fn(),
      } as never,
      testState.env as unknown as Env,
      createExecutionContextMock(),
    );
    await Promise.all(testState.workflowPromises);
  }

  it("skips premature scheduled events, isolates manual imports from weekly cadence, executes 1 scoped scheduled run when due, blocks duplicates, and preserves daily idempotency", async () => {
    const client = database.client!;

    // ------------------------------------------------------------------
    // 1. Seed a historical manual read-only import on 2026-11-14 (matching live local DB state)
    // ------------------------------------------------------------------
    vi.setSystemTime(new Date("2026-11-14T15:15:00.000Z"));
    const manualRes = await RankTrackingService.triggerReadOnlySync({
      configId: APPROVED_PILOT_CONFIG_ID,
      projectId: APPROVED_PILOT_PROJECT_ID,
      billingCustomer: {
        userId: "local-dev-user",
        userEmail: "local@example.com",
        organizationId: ORG_ID,
        projectId: APPROVED_PILOT_PROJECT_ID,
      },
    });
    expect(manualRes.ok).toBe(true);

    const manualRuns = await client.execute(
      `SELECT id, trigger, status, keywords_total FROM rank_check_runs`,
    );
    expect(manualRuns.rows).toHaveLength(1);
    expect(manualRuns.rows[0].trigger).toBe("manual");
    expect(manualRuns.rows[0].status).toBe("completed");
    expect(manualRuns.rows[0].keywords_total).toBe(1);

    // ------------------------------------------------------------------
    // 2. Premature scheduled invocation on 2026-11-17 (before 2026-11-18T07:24Z)
    // ------------------------------------------------------------------
    recordedRequests = [];
    vi.setSystemTime(new Date("2026-11-17T07:24:00.000Z"));
    await invokeWorkerScheduled();

    const scheduledBeforeDue = await client.execute(
      `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
    );
    expect(scheduledBeforeDue.rows).toHaveLength(0);
    expect(recordedRequests).toHaveLength(0);

    // Frontend-facing config still exposes 2026-11-18T07:24:00.000Z despite Nov 14 manual import
    const configsBeforeDue = await RankTrackingService.getConfigsForProject(
      APPROVED_PILOT_PROJECT_ID,
    );
    expect(configsBeforeDue[0].nextCheckAt).toBe("2026-11-18T07:24:00.000Z");

    // ------------------------------------------------------------------
    // 3. Eligible scheduled event on 2026-11-18T07:25:00Z -> MUST run even though
    //    manual read-only sync ran 4 days prior on Nov 14!
    // ------------------------------------------------------------------
    availableDates = ["2026-11-14", "2026-11-18"];
    recordedRequests = [];
    vi.setSystemTime(new Date("2026-11-18T07:25:00.000Z"));
    await invokeWorkerScheduled();

    const scheduledAfterDue = await client.execute(
      `SELECT id, trigger, status, keywords_total, keywords_checked, is_subset_run FROM rank_check_runs WHERE trigger = 'scheduled'`,
    );
    expect(scheduledAfterDue.rows).toHaveLength(1);
    expect(scheduledAfterDue.rows[0].status).toBe("completed");
    expect(scheduledAfterDue.rows[0].keywords_total).toBe(1);
    expect(scheduledAfterDue.rows[0].keywords_checked).toBe(1);
    expect(scheduledAfterDue.rows[0].is_subset_run).toBe(1);

    // Verify strictly GET calls to SE Ranking read endpoints (0 POSTs, 0 other providers)
    expect(recordedRequests.length).toBeGreaterThanOrEqual(4);
    expect(
      recordedRequests.some((r) => r.url.includes("/sites/check-dates")),
    ).toBe(true);
    expect(
      recordedRequests.some((r) => r.url.includes("/sites/positions")),
    ).toBe(true);
    for (const req of recordedRequests) {
      expect(req.method).toBe("GET");
      expect(
        req.url.startsWith("https://api.seranking.com/v1/project-management/"),
      ).toBe(true);
      expect(req.url.includes("/positions/recheck")).toBe(false);
    }

    // Verify ONLY approved pilot keyword x 2 targets were persisted (never NON_PILOT_KEYWORD_ID)
    const firstScheduledRunId = scheduledAfterDue.rows[0].id as string;
    const snapshotsAfterFirstCron = await client.execute({
      sql: `SELECT tracking_keyword_id, tracking_target_id, device, position, checked_date, observation_source
            FROM rank_snapshots WHERE run_id = ?
            ORDER BY device ASC, checked_date ASC`,
      args: [firstScheduledRunId],
    });
    expect(
      snapshotsAfterFirstCron.rows.every(
        (r) => r.tracking_keyword_id === APPROVED_PILOT_KEYWORD_ID,
      ),
    ).toBe(true);
    // 2026-11-14 already matched manual daily_sync import (same pos/url -> deduplicated), so only 2026-11-18 new rows inserted for desktop & mobile!
    expect(snapshotsAfterFirstCron.rows).toHaveLength(2);
    expect(snapshotsAfterFirstCron.rows.map((r) => r.device)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(snapshotsAfterFirstCron.rows.map((r) => r.checked_date)).toEqual([
      "2026-11-18",
      "2026-11-18",
    ]);
    expect(
      snapshotsAfterFirstCron.rows.every(
        (r) => r.observation_source === "daily_sync",
      ),
    ).toBe(true);

    // Verify next_check_at advanced consistently by +7d to 2026-11-25T07:24:00.000Z
    const cfgAfterFirstCron = await client.execute(
      `SELECT next_check_at FROM rank_tracking_configs WHERE id = '${APPROVED_PILOT_CONFIG_ID}'`,
    );
    expect(cfgAfterFirstCron.rows[0].next_check_at).toBe(
      "2026-11-25T07:24:00.000Z",
    );

    // ------------------------------------------------------------------
    // 4. Duplicate 15-minute cron ticks MUST NOT produce concurrent/duplicate runs or shift next_check_at
    // ------------------------------------------------------------------
    recordedRequests = [];
    vi.setSystemTime(new Date("2026-11-18T07:40:00.000Z"));
    await invokeWorkerScheduled();
    vi.setSystemTime(new Date("2026-11-21T09:00:00.000Z"));
    await invokeWorkerScheduled();

    const scheduledAfterDuplicates = await client.execute(
      `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
    );
    expect(scheduledAfterDuplicates.rows).toHaveLength(1);
    expect(recordedRequests).toHaveLength(0);
    const cfgAfterDupes = await client.execute(
      `SELECT next_check_at FROM rank_tracking_configs WHERE id = '${APPROVED_PILOT_CONFIG_ID}'`,
    );
    expect(cfgAfterDupes.rows[0].next_check_at).toBe(
      "2026-11-25T07:24:00.000Z",
    );

    // ------------------------------------------------------------------
    // 5. Concurrent active manual run on due date blocks scheduled start WITHOUT postponing next_check_at
    // ------------------------------------------------------------------
    vi.setSystemTime(new Date("2026-11-25T07:25:00.000Z"));
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, keywords_total, trigger, started_at)
       VALUES ('active-manual-run', '${APPROVED_PILOT_CONFIG_ID}', '${APPROVED_PILOT_PROJECT_ID}', 'running', 1, 'manual', '2026-11-25 07:24:30')`,
    );
    recordedRequests = [];
    await invokeWorkerScheduled();

    const scheduledDuringManual = await client.execute(
      `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
    );
    expect(scheduledDuringManual.rows).toHaveLength(1);
    expect(recordedRequests).toHaveLength(0);
    const cfgDuringManual = await client.execute(
      `SELECT next_check_at FROM rank_tracking_configs WHERE id = '${APPROVED_PILOT_CONFIG_ID}'`,
    );
    expect(cfgDuringManual.rows[0].next_check_at).toBe(
      "2026-11-25T07:24:00.000Z",
    );

    // Manual run completes -> next 15-min tick executes the weekly scheduled sync!
    await client.execute(
      `UPDATE rank_check_runs SET status = 'completed', completed_at = '2026-11-25T07:26:00.000Z' WHERE id = 'active-manual-run'`,
    );

    // Also simulate a provider correction on 2026-11-18 mobile (pos 41 -> 39) + new date 2026-11-25
    availableDates = ["2026-11-14", "2026-11-18", "2026-11-25"];
    positionsByEngine[String(APPROVED_PILOT_DESKTOP_ENGINE_ID)].push({
      date: "2026-11-25",
      pos: 68,
      url: "https://sports-ms.com/multi-purpose",
    });
    positionsByEngine[String(APPROVED_PILOT_MOBILE_ENGINE_ID)] = [
      {
        date: "2026-11-14",
        pos: 47,
        url: "https://sports-ms.com/multi-purpose",
      },
      {
        date: "2026-11-18",
        pos: 39,
        url: "https://sports-ms.com/multi-purpose",
      },
      {
        date: "2026-11-25",
        pos: 35,
        url: "https://sports-ms.com/multi-purpose",
      },
    ];

    vi.setSystemTime(new Date("2026-11-25T07:39:00.000Z"));
    recordedRequests = [];
    await invokeWorkerScheduled();

    const scheduledAfterSecondDue = await client.execute(
      `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
    );
    expect(scheduledAfterSecondDue.rows).toHaveLength(2);
    const cfgAfterSecondCron = await client.execute(
      `SELECT next_check_at FROM rank_tracking_configs WHERE id = '${APPROVED_PILOT_CONFIG_ID}'`,
    );
    expect(cfgAfterSecondCron.rows[0].next_check_at).toBe(
      "2026-12-02T07:24:00.000Z",
    );

    // Desktop 2026-11-18 unchanged -> deduplicated; Mobile 2026-11-18 corrected (39) + 2026-11-25 (desktop 68, mobile 35) inserted!
    const allMobileNov18 = await client.execute(
      `SELECT position, provider_status FROM rank_snapshots
       WHERE tracking_keyword_id = '${APPROVED_PILOT_KEYWORD_ID}' AND device = 'mobile' AND checked_date = '2026-11-18'
       ORDER BY id ASC`,
    );
    expect(allMobileNov18.rows.map((r) => r.position)).toEqual([41, 39]);
    const correctedStatus = allMobileNov18.rows[1].provider_status;
    expect(
      typeof correctedStatus === "string" ? correctedStatus : "",
    ).toContain('"previousImportedPosition":41');
    expect(recordedRequests.every((r) => r.method === "GET")).toBe(true);
  });
});
