import type { Client } from "@libsql/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const testState = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  workflowPromises: [] as Promise<unknown>[],
}));

vi.mock("cloudflare:workers", () => ({
  get env() {
    return testState.env;
  },
  waitUntil: vi.fn(),
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

vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/schema");
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  database.client = client;
  database.db = db;
  return { db };
});

vi.mock("@/server/workflows/RankCheckWorkflow", () => {
  return {
    RankCheckWorkflow: class {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async run(event: { payload: { params: Record<string, unknown> } }) {
        const { params } = event.payload;
        const runId = params.runId as string;
        const p = (async () => {
          const { RankTrackingRepository } =
            await import("@/server/features/rank-tracking/repositories/RankTrackingRepository");
          // Mark run as completed while preserving trigger and params
          await RankTrackingRepository.updateRun(runId, {
            status: "completed",
            completedAt: new Date().toISOString(),
            keywordsChecked:
              (params.keywordIds as string[] | undefined)?.length ?? 1,
          });
        })();
        testState.workflowPromises.push(p);
        return p;
      }
    },
  };
});

const {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_KEYWORD_ID,
  APPROVED_PILOT_DESKTOP_ENGINE_ID,
  APPROVED_PILOT_MOBILE_ENGINE_ID,
  runScheduledRankChecks,
} =
  await import("@/server/features/rank-tracking/services/scheduledRankChecks");
const { RankTrackingRepository } =
  await import("@/server/features/rank-tracking/repositories/RankTrackingRepository");
const { RankTrackingService } =
  await import("@/server/features/rank-tracking/services/RankTrackingService");
const { computeAccountFingerprint, SeRankingProjectSyncService } =
  await import("@/server/features/rank-tracking/services/SeRankingProjectSyncService");
const { fingerprintProviderCredential } =
  await import("@/server/features/serp/circuitBreaker");

describe("Scheduled Trigger & Account Fingerprint Identity Verification", () => {
  const originalFetch = globalThis.fetch;
  const ORG_ID = "org-pilot-test";
  const TEST_API_KEY = "seranking-prod-auth-key-secret-999";

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

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
      `CREATE UNIQUE INDEX se_ranking_project_bindings_project_account_idx
       ON se_ranking_project_bindings(local_project_id, provider_account_binding_id)`,
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
      `CREATE UNIQUE INDEX rank_check_runs_one_active_per_config_idx
       ON rank_check_runs(config_id) WHERE status IN ('pending', 'running')`,
    );
    await client.execute(
      `CREATE TABLE rank_snapshots (
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
      )`,
    );

    // Seed pilot entities
    await client.execute(`INSERT INTO organization (id) VALUES ('${ORG_ID}')`);
    await client.execute(
      `INSERT INTO projects (id, organization_id, name, domain)
       VALUES ('${APPROVED_PILOT_PROJECT_ID}', '${ORG_ID}', 'sports-ms.com', 'sports-ms.com')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_configs (id, project_id, domain, schedule_interval, next_check_at, is_active)
       VALUES ('${APPROVED_PILOT_CONFIG_ID}', '${APPROVED_PILOT_PROJECT_ID}', 'sports-ms.com', 'weekly', '2026-11-18T07:24:00.000Z', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_keywords (id, config_id, keyword)
       VALUES ('${APPROVED_PILOT_KEYWORD_ID}', '${APPROVED_PILOT_CONFIG_ID}', 'إنشاء ملاعب متعددة الأغراض')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device, enabled)
       VALUES ('target-eg-ar-desktop', '${ORG_ID}', '${APPROVED_PILOT_PROJECT_ID}', '${APPROVED_PILOT_CONFIG_ID}', 'EG', 'ar', 'desktop', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device, enabled)
       VALUES ('target-eg-ar-mobile', '${ORG_ID}', '${APPROVED_PILOT_PROJECT_ID}', '${APPROVED_PILOT_CONFIG_ID}', 'EG', 'ar', 'mobile', 1)`,
    );

    // Mock global fetch for SE Ranking Project API calls
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.href;
      const parsed = new URL(url);

      if (parsed.pathname === "/v1/project-management/users/me") {
        return new Response(
          JSON.stringify({ id: 1, email: "pilot@example.com" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (parsed.pathname === "/v1/project-management/sites") {
        return new Response(
          JSON.stringify([
            {
              id: 13188608,
              name: "https://sports-ms.com",
              title: "sports-ms.com",
              url: "https://sports-ms.com",
              depth: 100,
              subdomain_match: 1,
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
              id: 24606031,
              name: "إنشاء ملاعب متعددة الأغراض",
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
        return new Response(JSON.stringify(["2026-11-18"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (parsed.pathname.endsWith("/sites/positions")) {
        return new Response(
          JSON.stringify([
            {
              id: 24606031,
              name: "إنشاء ملاعب متعددة الأغراض",
              positions: [
                {
                  date: "2026-11-18",
                  pos: 42,
                  change: 0,
                  landing_pages: [
                    {
                      url: "https://sports-ms.com/multi-purpose",
                      date: "2026-11-18",
                    },
                  ],
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    testState.workflowPromises = [];
  });

  // =========================================================================
  // SECTION 1: Scheduled Trigger Identity End-to-End
  // =========================================================================
  describe("1. Scheduled Trigger Identity Verification", () => {
    it("persists trigger as 'scheduled' (never 'scheduled_cron'), identifies it via getLatestScheduledRunForConfig, enforces weekly spacing, and isolates manual Check All", async () => {
      const client = database.client!;

      const mockWorkflow = {
        async create(event: { id: string; params: Record<string, unknown> }) {
          const runId = event.params.runId as string;
          const p = (async () => {
            await RankTrackingRepository.updateRun(runId, {
              status: "completed",
              completedAt: new Date().toISOString(),
              keywordsChecked:
                (event.params.keywordIds as string[] | undefined)?.length ?? 1,
            });
          })();
          testState.workflowPromises.push(p);
          return p;
        },
        async get() {
          return {
            terminate: vi.fn(),
          };
        },
      };

      testState.env.RANK_CHECK_WORKFLOW = mockWorkflow;
      testState.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";

      const mockEnv = testState.env as unknown as Env;

      // 1. Initial due date: 2026-11-18T07:25:00Z
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-18T07:25:00.000Z"));

      await runScheduledRankChecks(mockEnv);
      await Promise.all(testState.workflowPromises);

      // Verify the persisted database trigger is strictly "scheduled"
      const runs = await client.execute(
        `SELECT id, config_id, project_id, trigger, status FROM rank_check_runs WHERE config_id = '${APPROVED_PILOT_CONFIG_ID}'`,
      );
      expect(runs.rows).toHaveLength(1);
      const firstRun = runs.rows[0];
      expect(firstRun.trigger).toBe("scheduled");
      expect(firstRun.trigger).not.toBe("scheduled_cron");
      expect(firstRun.status).toBe("completed");

      // Verify getLatestScheduledRunForConfig correctly finds the scheduled run
      const latestScheduled =
        await RankTrackingRepository.getLatestScheduledRunForConfig(
          APPROVED_PILOT_CONFIG_ID,
        );
      expect(latestScheduled).not.toBeNull();
      expect(latestScheduled?.id).toBe(firstRun.id);
      expect(latestScheduled?.trigger).toBe("scheduled");

      // 2. Second cron tick 15 minutes later (2026-11-18T07:40:00Z):
      // Must NOT schedule a duplicate run because weekly spacing has not elapsed
      vi.setSystemTime(new Date("2026-11-18T07:40:00.000Z"));
      await runScheduledRankChecks(mockEnv);
      await Promise.all(testState.workflowPromises);

      const runsAfterSecondTick = await client.execute(
        `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
      );
      expect(runsAfterSecondTick.rows).toHaveLength(1);

      // 3. Manual Check All / Read-Only Sync triggered 2 days later (2026-11-20T12:00:00Z)
      // Must persist trigger="manual" and NOT affect scheduled eligibility
      vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
      const manualResult = await RankTrackingService.triggerReadOnlySync({
        configId: APPROVED_PILOT_CONFIG_ID,
        projectId: APPROVED_PILOT_PROJECT_ID,
        billingCustomer: {
          userId: "operator-user",
          userEmail: "operator@example.com",
          organizationId: ORG_ID,
          projectId: APPROVED_PILOT_PROJECT_ID,
        },
      });
      expect(manualResult.ok).toBe(true);
      await Promise.all(testState.workflowPromises);

      const allRuns = await client.execute(
        `SELECT id, trigger, status FROM rank_check_runs WHERE config_id = '${APPROVED_PILOT_CONFIG_ID}' ORDER BY started_at ASC`,
      );
      expect(allRuns.rows).toHaveLength(2);
      expect(allRuns.rows[0].trigger).toBe("scheduled");
      expect(allRuns.rows[1].trigger).toBe("manual");

      // Verify getLatestScheduledRunForConfig ignores the manual run and STILL returns the scheduled run
      const scheduledAfterManual =
        await RankTrackingRepository.getLatestScheduledRunForConfig(
          APPROVED_PILOT_CONFIG_ID,
        );
      expect(scheduledAfterManual?.id).toBe(firstRun.id);
      expect(scheduledAfterManual?.trigger).toBe("scheduled");

      // 4. Cron tick on 2026-11-21 (3 days after first scheduled, 1 day after manual):
      // Weekly spacing has still NOT elapsed (min spacing is 6 days), so it skips
      vi.setSystemTime(new Date("2026-11-21T07:25:00.000Z"));
      await runScheduledRankChecks(mockEnv);
      await Promise.all(testState.workflowPromises);

      const runsAfterDay3 = await client.execute(
        `SELECT id FROM rank_check_runs WHERE trigger = 'scheduled'`,
      );
      expect(runsAfterDay3.rows).toHaveLength(1);

      // 5. Cron tick on 2026-11-25T07:30:00Z (7 days after first scheduled run):
      // Weekly spacing has now elapsed -> Second scheduled run MUST execute!
      vi.setSystemTime(new Date("2026-11-25T07:30:00.000Z"));
      await runScheduledRankChecks(mockEnv);
      await Promise.all(testState.workflowPromises);

      const runsAfterWeek = await client.execute(
        `SELECT id, trigger, status FROM rank_check_runs WHERE trigger = 'scheduled'`,
      );
      expect(runsAfterWeek.rows).toHaveLength(2);
      expect(runsAfterWeek.rows.every((r) => r.trigger === "scheduled")).toBe(
        true,
      );
    });
  });

  // =========================================================================
  // SECTION 2: Account Fingerprint Consistency with REAL Production Binding Code
  // =========================================================================
  describe("2. Account Fingerprint & Binding Identity Consistency", () => {
    it("compares computeAccountFingerprint vs fingerprintProviderCredential and confirms distinct formats", async () => {
      const apiKey = "test-seranking-live-api-key-xyz123";

      // computeAccountFingerprint: production account binding identity (64-char SHA-256)
      const dbFingerprint = computeAccountFingerprint(apiKey);
      expect(dbFingerprint).toHaveLength(64);
      expect(typeof dbFingerprint).toBe("string");
      expect(/^[0-9a-f]{64}$/.test(dbFingerprint)).toBe(true);

      // fingerprintProviderCredential: in-memory circuit breaker identity (24-char truncated hex)
      const circuitFingerprint = await fingerprintProviderCredential(
        "seranking",
        [apiKey],
      );
      expect(circuitFingerprint).not.toBeNull();
      expect(circuitFingerprint).toHaveLength(24);
      expect(/^[0-9a-f]{24}$/.test(circuitFingerprint!)).toBe(true);

      // Distinct identities: circuit breaker fingerprint can NEVER match or collide with DB fingerprint
      expect(dbFingerprint).not.toBe(circuitFingerprint);
    });

    it("verifies production ensureAccountBinding and ensureProject are strictly idempotent across repeated scheduled executions", async () => {
      const client = database.client!;

      // First run: ensureAccountBinding with production code
      const firstAccount =
        await SeRankingProjectSyncService.ensureAccountBinding({
          organizationId: ORG_ID,
          apiKey: TEST_API_KEY,
        });

      expect(firstAccount.binding).toBeDefined();
      expect(firstAccount.binding.accountFingerprint).toBe(
        computeAccountFingerprint(TEST_API_KEY),
      );
      expect(firstAccount.binding.accountFingerprint).toHaveLength(64);

      const accountsInDb = await client.execute(
        `SELECT id, organization_id, account_fingerprint, status FROM se_ranking_account_bindings WHERE organization_id = '${ORG_ID}'`,
      );
      expect(accountsInDb.rows).toHaveLength(1);
      const initialAccountId = accountsInDb.rows[0].id;
      expect(accountsInDb.rows[0].account_fingerprint).toBe(
        computeAccountFingerprint(TEST_API_KEY),
      );

      // First run: ensureProject with production code
      const firstProject = await SeRankingProjectSyncService.ensureProject({
        localProjectId: APPROVED_PILOT_PROJECT_ID,
        organizationId: ORG_ID,
        domain: "sports-ms.com",
        apiKey: TEST_API_KEY,
        readOnlySync: true,
      });

      expect(firstProject.projectBinding).toBeDefined();
      expect(firstProject.remoteSiteId).toBe(13188608);

      const projectBindingsInDb = await client.execute(
        `SELECT id, local_project_id, provider_account_binding_id, remote_site_id, status
         FROM se_ranking_project_bindings WHERE local_project_id = '${APPROVED_PILOT_PROJECT_ID}'`,
      );
      expect(projectBindingsInDb.rows).toHaveLength(1);
      const initialProjectBindingId = projectBindingsInDb.rows[0].id;
      expect(projectBindingsInDb.rows[0].provider_account_binding_id).toBe(
        initialAccountId,
      );

      // -----------------------------------------------------------------------
      // Second execution: Simulate repeated scheduled sync with the SAME API key
      // -----------------------------------------------------------------------
      const secondAccount =
        await SeRankingProjectSyncService.ensureAccountBinding({
          organizationId: ORG_ID,
          apiKey: TEST_API_KEY,
        });

      // Must reuse existing account binding ID, NOT create a new one
      expect(secondAccount.binding.id).toBe(initialAccountId);

      const accountsAfterRepeat = await client.execute(
        `SELECT id FROM se_ranking_account_bindings WHERE organization_id = '${ORG_ID}'`,
      );
      expect(accountsAfterRepeat.rows).toHaveLength(1);

      const secondProject = await SeRankingProjectSyncService.ensureProject({
        localProjectId: APPROVED_PILOT_PROJECT_ID,
        organizationId: ORG_ID,
        domain: "sports-ms.com",
        apiKey: TEST_API_KEY,
        readOnlySync: true,
      });

      // Must reuse existing project binding ID and remoteSiteId without conflict
      expect(secondProject.projectBinding.id).toBe(initialProjectBindingId);
      expect(secondProject.remoteSiteId).toBe(13188608);

      const projectBindingsAfterRepeat = await client.execute(
        `SELECT id, provider_account_binding_id FROM se_ranking_project_bindings
         WHERE local_project_id = '${APPROVED_PILOT_PROJECT_ID}'`,
      );
      expect(projectBindingsAfterRepeat.rows).toHaveLength(1);
      expect(projectBindingsAfterRepeat.rows[0].id).toBe(
        initialProjectBindingId,
      );
      expect(
        projectBindingsAfterRepeat.rows[0].provider_account_binding_id,
      ).toBe(initialAccountId);
    });
  });
});
