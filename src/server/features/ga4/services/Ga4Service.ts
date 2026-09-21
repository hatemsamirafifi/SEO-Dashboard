import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import {
  createGa4Client,
  ga4ReportResultSchema,
  type Ga4Property,
  type Ga4ReportRequest,
  type Ga4ReportResult,
} from "@/server/lib/ga4Client";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import {
  recordCacheHit,
  recordCacheMiss,
  recordFreeProviderCall,
} from "@/server/lib/seo-data/cost-tracker";
import { singleFlight } from "@/server/lib/seo-data/single-flight";
import { traceCacheDecision } from "@/server/lib/seo-data/trace";
import { traceDirectProviderCall } from "@/server/features/sam/samTraceBus";
import { GA4_CACHE_TTL_SECONDS } from "@/shared/ga4";
import { Ga4GrantRepository } from "../repositories/Ga4GrantRepository";
import {
  Ga4ConnectionRepository,
  type Ga4Connection,
} from "../repositories/Ga4ConnectionRepository";

const periodUsersSchema = z.object({
  asOf: z.string(),
  data: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
  }),
});

export type Ga4PeriodUsers = z.infer<typeof periodUsersSchema>;

type ReportCacheOutcome = {
  data: Ga4ReportResult;
  fromCache: boolean;
};

/** Deterministic cache params: organization + property + normalized request,
 *  sorted keys. Mirrors the router cache-key convention (org always part of
 *  the key). Tokens are never part of cache keys or payloads. */
async function reportCacheKey(
  organizationId: string,
  request: Record<string, unknown>,
) {
  return buildCacheKey("ga4:report", { organizationId, request });
}

/** Cache-first report flow mirroring the DataRouter seam composition
 *  (cache → singleFlight → trace) without registering a router provider. */
async function runReportCached(input: {
  connection: Ga4Connection;
  request: Ga4ReportRequest;
}): Promise<ReportCacheOutcome> {
  const { connection, request } = input;
  const key = await reportCacheKey(connection.organizationId, {
    propertyId: connection.propertyId,
    dateRanges: request.dateRanges,
    dimensions: request.dimensions,
    metrics: request.metrics,
    dimensionFilter: request.dimensionFilter ?? null,
    limit: request.limit ?? null,
    offset: request.offset ?? null,
  });
  const raw = await getCached(key);
  if (raw !== null) {
    const parsed = ga4ReportResultSchema.safeParse(raw);
    if (parsed.success) {
      recordCacheHit();
      traceCacheDecision(true);
      return { data: parsed.data, fromCache: true };
    }
  }
  recordCacheMiss();
  traceCacheDecision(false);
  const client = createGa4Client({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
  });
  const data = await singleFlight(key, () =>
    traceDirectProviderCall("ga4", () =>
      client.runReport({ ...request, propertyId: connection.propertyId }),
    ),
  );
  await setCached(key, data, GA4_CACHE_TTL_SECONDS);
  recordFreeProviderCall("ga4");
  return { data, fromCache: false };
}

type GrantProperties = { accountId: string; properties: Ga4Property[] };

async function grants(userId: string) {
  return Ga4GrantRepository.listForUser(userId);
}
async function userHasGrant(userId: string) {
  return (await grants(userId)).some((grant) =>
    Ga4GrantRepository.hasAnalyticsConsent(grant.scope),
  );
}
async function getConnection(
  projectId: string,
  organizationId: string,
): Promise<Ga4Connection | null> {
  return Ga4ConnectionRepository.getByProjectId(projectId, organizationId);
}
async function listPropertiesForUser(
  userId: string,
): Promise<GrantProperties[]> {
  const userGrants = await grants(userId);
  return Promise.all(
    userGrants
      .filter((grant) => Ga4GrantRepository.hasAnalyticsConsent(grant.scope))
      .map(async ({ accountId }) => ({
        accountId,
        properties: await createGa4Client({
          userId,
          ga4AccountId: accountId,
        }).listProperties(),
      })),
  );
}
async function setProperty(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  accountId: string;
  propertyId: string;
}) {
  const userGrants = await grants(input.userId);
  if (!userGrants.some((grant) => grant.accountId === input.accountId))
    throw new AppError(
      "NOT_FOUND",
      "That Google Analytics account isn't connected to your OpenSEO account.",
    );
  const properties = await createGa4Client({
    userId: input.userId,
    ga4AccountId: input.accountId,
  }).listProperties();
  const property = properties.find(
    (entry) => entry.propertyId === input.propertyId,
  );
  if (!property)
    throw new AppError(
      "NOT_FOUND",
      "That Google Analytics property isn't available on your connected Google account.",
    );
  return Ga4ConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    connectedByUserId: input.userId,
    ga4AccountId: input.accountId,
    propertyId: property.propertyId,
    propertyDisplayName: property.displayName,
    currencyCode: property.currencyCode,
    hasEcommerce: false,
  });
}
async function disconnect(input: {
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const connection = await getConnection(input.projectId, input.organizationId);
  await Ga4ConnectionRepository.deleteByProjectId(
    input.projectId,
    input.organizationId,
  );
  if (connection?.connectedByUserId !== input.userId) return;
  if (
    !(await Ga4ConnectionRepository.existsForConnectorAccount(
      input.userId,
      connection.ga4AccountId,
    ))
  ) {
    await Ga4GrantRepository.deleteForUserAccount(
      input.userId,
      connection.ga4AccountId,
    );
  }
}
export const Ga4Service = {
  userHasGrant,
  getConnection,
  listPropertiesForUser,
  setProperty,
  disconnect,
  runReportForConnection,
  getPeriodUsers,
};

async function requireConnection(projectId: string, organizationId: string) {
  const connection = await getConnection(projectId, organizationId);
  if (!connection)
    throw new AppError(
      "NOT_FOUND",
      "Google Analytics is not connected for this project.",
    );
  return connection;
}

async function runReportForConnection(input: {
  projectId: string;
  organizationId: string;
  request: Ga4ReportRequest;
}): Promise<ReportCacheOutcome> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  return runReportCached({ connection, request: input.request });
}

type PeriodUsersOutcome = Ga4PeriodUsers & { fromCache: boolean };

async function getPeriodUsers(input: {
  projectId: string;
  organizationId: string;
  startDate: string;
  endDate: string;
}): Promise<PeriodUsersOutcome> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  const key = await buildCacheKey("ga4:distinct-users", {
    organizationId: connection.organizationId,
    propertyId: connection.propertyId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const raw = await getCached(key);
  if (raw !== null) {
    const parsed = periodUsersSchema.safeParse(raw);
    if (parsed.success) {
      recordCacheHit();
      traceCacheDecision(true);
      return { fromCache: true, ...parsed.data };
    }
  }
  recordCacheMiss();
  traceCacheDecision(false);
  const client = createGa4Client({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
  });
  const report = await singleFlight(key, () =>
    traceDirectProviderCall("ga4", () =>
      client.runReport({
        propertyId: connection.propertyId,
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        dimensions: [],
        metrics: ["totalUsers", "activeUsers"],
      }),
    ),
  );
  const payload: Ga4PeriodUsers = {
    asOf: new Date().toISOString(),
    data: {
      totalUsers: report.rows[0]?.metricValues[0] ?? 0,
      activeUsers: report.rows[0]?.metricValues[1] ?? 0,
    },
  };
  await setCached(key, payload, GA4_CACHE_TTL_SECONDS);
  recordFreeProviderCall("ga4");
  return { fromCache: false, ...payload };
}
