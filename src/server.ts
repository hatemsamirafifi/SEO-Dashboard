import { timingSafeEqual } from "node:crypto";
import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { routeAgentRequest } from "agents";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { runScheduledRankChecks } from "@/server/features/rank-tracking/services/scheduledRankChecks";
import { runScheduledGscSync } from "@/server/features/gsc/services/scheduledGscSync";
import { runScheduledGa4Sync } from "@/server/features/ga4/services/scheduledGa4Sync";
import { runScheduledGoogleAdsSync } from "@/server/features/google-ads/services/scheduledGoogleAdsSync";
import { runScheduledIntelligenceScan } from "@/server/features/intelligence/services/scheduledIntelligenceScan";
import { runScheduledReportRuns } from "@/server/features/reports/services/scheduledReportRuns";
import { getOrCreateOrganizationCustomer } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import type {
  OpenSeoOAuthEnv,
  createOpenSeoOAuthProvider,
} from "@/server/mcp/oauth-provider";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";
import { withPgClient } from "@/db";
import {
  AUTUMN_WEBHOOK_PATH,
  handleAutumnWebhookRequest,
} from "@/server/billing/autumn-webhook";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";

// Keep in sync with MCP_ROUTE in @/server/mcp/context — inlined as a literal
// so importing it here cannot pull the MCP module graph into the eager
// startup bundle (SDK protocol schemas + every tool's zod schemas evaluate
// at module scope and push the Worker toward its 400ms startup CPU limit).
const MCP_ROUTE = "/mcp";

const appFetch = createStartHandler(defaultStreamHandler);

// Lazy singleton: the OAuth provider is only needed on the hosted auth path,
// and building it evaluates the MCP stack (see MCP_ROUTE above).
let openSeoOAuthProviderPromise: Promise<
  ReturnType<typeof createOpenSeoOAuthProvider>
> | null = null;

function getOpenSeoOAuthProvider() {
  openSeoOAuthProviderPromise ??= import("@/server/mcp/oauth-provider").then(
    (m) => m.createOpenSeoOAuthProvider(appFetch),
  );
  return openSeoOAuthProviderPromise;
}

// Authorize an onboarding-chat connection in the Worker, before it reaches the
// Durable Object. The DO instance name is the projectId (set client-side); we
// resolve the session here and confirm the caller's org owns that project, so
// the DO can trust its `name`. Returning a Response rejects; void lets it through.
async function authorizeOnboardingChat(
  request: Request,
  projectId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    context.organizationId,
  );
  if (!project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Ensure the org's Autumn customer exists (and gets its default onboarding-plan
  // credits) before the DO checks the balance — otherwise a brand-new org's first
  // message can hit a false "out of credits" gate. Hosted-only; self-hosted has
  // no Autumn.
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}

// Authorize a SAM agent connection in the Worker, before it reaches the Durable
// Object. The DO instance name is the sessionId (set client-side); we resolve
// the session here and authorize the caller against the session's project via
// the same canonical project-access check the rest of the app uses, so the DO
// can trust its `name` and derive org/project/user from the session row.
async function authorizeSamChat(
  request: Request,
  sessionId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = await SamSessionRepository.getActiveSession(
    sessionId,
    context.userId,
  );
  const project = session
    ? await ProjectRepository.getProjectForOrganization(
        session.projectId,
        context.organizationId,
      )
    : null;
  if (!session || !project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Same as onboarding above: make sure the Autumn customer (and its default
  // free-plan credits) exists before the DO's balance gate runs, or a brand-new
  // org's first message hits a false "out of credits".
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}

// Both chat DOs live behind /agents/*. Dispatch on the DO binding partyserver
// resolved for the request (rather than re-parsing the path), and fail closed
// on anything unrecognized.
function authorizeChatAgent(
  request: Request,
  lobby: { className: string; name: string },
): Promise<Response | undefined> | Response {
  switch (lobby.className) {
    case "SAM_CHAT":
      return authorizeSamChat(request, lobby.name);
    case "ONBOARDING_CHAT":
      return authorizeOnboardingChat(request, lobby.name);
    default:
      return new Response("Forbidden", { status: 403 });
  }
}

// Route /agents/* to the onboarding and SAM chat DOs. Auth happens here (both
// the WS upgrade and any HTTP message-history fetch), keeping it off the OAuth
// wrapper and TanStack route guard below.
async function routeChatAgents(request: Request, env: Env): Promise<Response> {
  const response = await routeAgentRequest(request, env, {
    onBeforeConnect: (req, lobby) => authorizeChatAgent(req, lobby),
    onBeforeRequest: (req, lobby) => authorizeChatAgent(req, lobby),
  });
  return response ?? new Response("Not found", { status: 404 });
}

function secureSecretCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

let scheduledRankChecksInProgress = false;

async function handleOperatorReadOnlySync(
  publicRequest: Request,
  authMode: ReturnType<typeof getAuthMode>,
  env: Env,
): Promise<Response> {
  // 1. Production / Hosted Guard: Fail closed. Exclude from hosted and access environments entirely.
  if (authMode !== "local_noauth") {
    return new Response("Not found", { status: 404 });
  }

  // 2. Explicit developer configuration guard: must be explicitly allowed even in local dev.
  const allowSync =
    env.ALLOW_LOCAL_PILOT_OPERATOR_SYNC === "true" ||
    process.env.ALLOW_LOCAL_PILOT_OPERATOR_SYNC === "true";
  if (!allowSync) {
    return new Response("Not found", { status: 404 });
  }

  // 3. HTTP method guard: POST only
  if (publicRequest.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 4. Operator Secret Constant-Time Authentication Check
  // Fails closed if no operator secret is configured.
  // Constant-time comparison prevents timing side-channels from LAN/network clients.
  const expectedSecret = (
    env.LOCAL_OPERATOR_SYNC_SECRET ||
    process.env.LOCAL_OPERATOR_SYNC_SECRET ||
    ""
  ).trim();

  if (!expectedSecret) {
    return new Response(
      JSON.stringify({ error: "Operator secret not configured" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const providedKey = (
    publicRequest.headers.get("x-local-operator-secret") ||
    publicRequest.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""
  ).trim();

  if (!providedKey || !secureSecretCompare(providedKey, expectedSecret)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // 5. Host Header Validation: Ensure requests originate from loopback/localhost or internal container
  const hostHeader = (publicRequest.headers.get("host") || "")
    .toLowerCase()
    .split(":")[0];
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "open-seo-dev",
  ]);
  if (hostHeader && !allowedHosts.has(hostHeader)) {
    return new Response(
      JSON.stringify({ error: "Forbidden: non-loopback host" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // 6. Zero-trust parameter isolation: caller-supplied body, headers, or query parameters
  // for authorization or IDs are strictly ignored. Derive project and organization
  // directly from the verified database records for the approved pilot constants.
  const { RankTrackingService } =
    await import("@/server/features/rank-tracking/services/RankTrackingService");
  const {
    APPROVED_PILOT_CONFIG_ID,
    APPROVED_PILOT_PROJECT_ID,
    APPROVED_PILOT_KEYWORD_IDS,
  } =
    await import("@/server/features/rank-tracking/services/scheduledRankChecks");
  const { RankTrackingRepository } =
    await import("@/server/features/rank-tracking/repositories/RankTrackingRepository");

  const config = await RankTrackingRepository.getConfigById({
    configId: APPROVED_PILOT_CONFIG_ID,
    projectId: APPROVED_PILOT_PROJECT_ID,
  });
  if (!config || !config.isActive) {
    return new Response("Pilot configuration not found or inactive", {
      status: 404,
    });
  }

  const project = await ProjectRepository.getProjectById(
    APPROVED_PILOT_PROJECT_ID,
  );
  if (!project || project.archivedAt) {
    return new Response("Pilot project not found or archived", {
      status: 404,
    });
  }

  const result = await RankTrackingService.triggerReadOnlySync({
    configId: APPROVED_PILOT_CONFIG_ID,
    projectId: APPROVED_PILOT_PROJECT_ID,
    billingCustomer: {
      userId: "local-dev-operator",
      userEmail: "dev-operator@local",
      organizationId: project.organizationId,
      projectId: APPROVED_PILOT_PROJECT_ID,
    },
    keywordIds: [...APPROVED_PILOT_KEYWORD_IDS],
  });

  return Response.json(result);
}

async function handleInternalCronEndpoint(
  publicRequest: Request,
  pathname: string,
  authMode: ReturnType<typeof getAuthMode>,
  env: Env,
): Promise<Response> {
  // 1. Production / Hosted Guard: Fail closed. Exclude from hosted and access environments entirely.
  if (authMode !== "local_noauth") {
    return new Response("Not found", { status: 404 });
  }

  // 2. Secret authentication check: fail closed if no secret is configured.
  // Never fallback to a hardcoded default. Constant-time comparison prevents timing side-channels.
  const expectedSecret = (
    process.env.LOCAL_SCHEDULER_SECRET ||
    env.LOCAL_SCHEDULER_SECRET ||
    ""
  ).trim();

  if (!expectedSecret) {
    return new Response(
      JSON.stringify({ error: "Scheduler secret not configured" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const providedKey = (
    publicRequest.headers.get("x-local-scheduler-key") ||
    publicRequest.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""
  ).trim();

  if (!providedKey || !secureSecretCompare(providedKey, expectedSecret)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  if (pathname === "/api/internal/cron/status") {
    const { getSchedulerHeartbeatStatus } =
      await import("@/server/features/rank-tracking/services/schedulerHeartbeat");
    return Response.json(getSchedulerHeartbeatStatus(env));
  }

  // Must be POST for trigger
  if (publicRequest.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 3. Fail-safe pilot default: scheduling must be explicitly enabled
  const pilotEnabled =
    env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true" ||
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED === "true";

  if (!pilotEnabled) {
    return Response.json({
      ok: false,
      reason: "pilot_disabled",
      message:
        "Scheduled rank check pilot is disabled by environment flag (SCHEDULED_RANK_TRACKING_PILOT_ENABLED !== 'true')",
    });
  }

  // 4. Overlapping execution guard (prevents concurrent scheduled runs)
  if (scheduledRankChecksInProgress) {
    return new Response(
      JSON.stringify({
        ok: false,
        reason: "already_running",
        message: "A scheduled rank check run is already in progress",
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const { recordSchedulerTick } =
    await import("@/server/features/rank-tracking/services/schedulerHeartbeat");

  try {
    scheduledRankChecksInProgress = true;
    await withPgClient(async () => {
      await runScheduledRankChecks(env);
    });
    const heartbeat = recordSchedulerTick(true);
    return Response.json({
      ok: true,
      message: "Scheduled rank check tick completed",
      timestamp: heartbeat.lastTickAt,
    });
  } catch (err) {
    console.error(
      "[internal:cron] Error executing scheduled rank checks:",
      err,
    );
    recordSchedulerTick(
      false,
      err instanceof Error ? err.message : String(err),
    );
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  } finally {
    scheduledRankChecksInProgress = false;
  }
}

function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Scope a per-request Postgres client (no-op in D1 mode). The client isn't
  // closed here — the Workers↔Hyperdrive socket is reclaimed at invocation end.
  return withPgClient(() => Promise.resolve(handleFetch(request, env, ctx)));
}

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  ctx.waitUntil(maybeSendSelfHostHeartbeat());

  const authMode = getAuthMode(env.AUTH_MODE);
  const publicRequest = requestWithPublicOrigin(request);
  const pathname = new URL(publicRequest.url).pathname;

  if (pathname.startsWith("/agents/")) {
    return routeChatAgents(publicRequest, env);
  }

  // Operator rank-tracking sync endpoint: strictly developer-only and excluded from production.
  // Fails closed on any hosted, cloudflare_access, or ambiguous environment.
  // The Cloudflare internal scheduled() handler runs independently and does not depend on this HTTP route.
  if (pathname === "/api/rank-tracking/read-only-sync") {
    return handleOperatorReadOnlySync(publicRequest, authMode, env);
  }

  // Internal local scheduler endpoints: safely triggers the internal scheduled() handler in Docker.
  // Gated strictly to local_noauth and requires secret header authentication. Excluded from production.
  if (
    pathname === "/api/internal/cron/trigger" ||
    pathname === "/api/internal/cron/status"
  ) {
    return handleInternalCronEndpoint(publicRequest, pathname, authMode, env);
  }

  if (isHostedAuthMode(authMode)) {
    if (pathname === AUTUMN_WEBHOOK_PATH) {
      return handleAutumnWebhookRequest(publicRequest);
    }

    const openSeoOAuthProvider = await getOpenSeoOAuthProvider();
    return openSeoOAuthProvider.fetch(
      publicRequest,
      env as OpenSeoOAuthEnv,
      ctx,
    );
  }

  if (
    (authMode === "cloudflare_access" || authMode === "local_noauth") &&
    pathname === MCP_ROUTE
  ) {
    // Lazy: see MCP_ROUTE above — the MCP server, its SDK protocol schemas,
    // and every tool's zod input/output schemas load on the first MCP
    // request, not at worker startup.
    const { handleSelfHostedOpenSeoMcpRequest } =
      await import("@/server/mcp/transport");
    return handleSelfHostedOpenSeoMcpRequest(publicRequest, authMode, env, ctx);
  }

  return appFetch(request);
}

// Export Workflow classes as named exports
export { SiteAuditWorkflow } from "./server/workflows/SiteAuditWorkflow";
export { RankCheckWorkflow } from "./server/workflows/RankCheckWorkflow";
export { AutopilotWorkflow } from "./server/workflows/AutopilotWorkflow";
// Durable Object class for the onboarding strategy chat (Agents SDK).
export { OnboardingChatAgent } from "./server/features/onboarding/OnboardingChatAgent";
// Durable Object class for the SAM in-app agent (Agents SDK).
export { SamChatAgent } from "./server/features/sam/SamChatAgent";
// Durable Object class for SE Ranking distributed rate limiting.
export { SeRankingRateLimiter } from "./server/lib/seranking/rateLimiter";
export { GoogleAdsPlannerLimiter } from "./server/lib/seo-data/providers/google-ads-planner-limiter";

export default {
  fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    // Scope a per-request Postgres client for the cron run (no-op in D1 mode).
    await withPgClient(async () => {
      await runScheduledRankChecks(env);
      await runScheduledGscSync();
      await runScheduledGa4Sync();
      await runScheduledGoogleAdsSync();
      await runScheduledIntelligenceScan();
      await runScheduledReportRuns();
    });
  },
};
