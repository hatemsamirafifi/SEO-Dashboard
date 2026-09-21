import { ORGANIC_CHANNEL_GROUP } from "@/shared/ga4";
import {
  ANALYTICS_RANGE_DAYS,
  type AnalyticsRange,
} from "@/types/schemas/ga4";
import { Ga4ConnectionRepository } from "../repositories/Ga4ConnectionRepository";
import {
  NEW_USERS_FOOTNOTE,
  Ga4SyncRepository,
  type Ga4AcquisitionGroup,
  type Ga4GrainCoverage,
  type Ga4LandingGroup,
} from "../repositories/Ga4SyncRepository";

export type MetricDelta = {
  current: number;
  previous: number;
  change: number;
  pctChange: number | null;
};

export type AnalyticsCoverage = {
  status: "complete" | "partial" | "none";
  coveredDates: number;
  totalDates: number;
  coveredThrough: string | null;
};

export type AnalyticsFilters = {
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
};

export type AnalyticsWindow = { from: string; to: string };
export type AnalyticsWindows = {
  current: AnalyticsWindow;
  previous: AnalyticsWindow;
};

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Current window (range ending today) plus the equivalent previous period
 *  of the same length, both as inclusive ISO date ranges. */
export function resolveAnalyticsWindows(
  range: AnalyticsRange,
  todayIso: string,
): AnalyticsWindows {
  const days = ANALYTICS_RANGE_DAYS[range];
  const current = { from: addDaysIso(todayIso, -(days - 1)), to: todayIso };
  const previousTo = addDaysIso(current.from, -1);
  return {
    current,
    previous: { from: addDaysIso(previousTo, -(days - 1)), to: previousTo },
  };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function deltaOf(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    change: current - previous,
    pctChange: pctChange(current, previous),
  };
}

/** Ratios derive from summed components at query time (§9.4) — daily rates
 *  are never averaged into period rates. Zero sessions is a valid zero. */
function ratioOf(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function engagementRateOf(input: {
  engagedSessions: number;
  sessions: number;
}): number {
  return ratioOf(input.engagedSessions, input.sessions);
}

function avgEngagementTimeOf(input: {
  userEngagementDuration: number;
  sessions: number;
}): number {
  return ratioOf(input.userEngagementDuration, input.sessions);
}

function toCoverage(
  coverage: Ga4GrainCoverage,
  totalDates: number,
): AnalyticsCoverage {
  const covered = coverage.coveredDates.length;
  return {
    status: covered >= totalDates ? "complete" : covered > 0 ? "partial" : "none",
    coveredDates: covered,
    totalDates,
    coveredThrough: coverage.coveredThrough,
  };
}

function currencyNoteFor(currencyCode: string | null): string {
  if (currencyCode) {
    return `Revenue in ${currencyCode}; single-currency amounts, never converted.`;
  }
  return "Revenue currency is unreported; amounts are shown as stored, never converted.";
}

function reservedFilterNoteFor(input: {
  device?: string;
  country?: string;
}): string | null {
  const parts: string[] = [];
  if (input.device) parts.push(`device "${input.device}"`);
  if (input.country) parts.push(`country "${input.country}"`);
  if (parts.length === 0) return null;
  return (
    `${parts.join(" and ")} accepted but not yet applied: stored grains ` +
    `have no device/country breakdown (geo/tech tables deferred). ` +
    `Totals reflect the full property.`
  );
}

function filtersOf(input: {
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
}): AnalyticsFilters {
  return {
    range: input.range,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.device ? { device: input.device } : {}),
    ...(input.country ? { country: input.country } : {}),
  };
}

async function requireConnection(projectId: string, organizationId: string) {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  if (!connection) return null;
  return connection;
}

type SummaryLike = {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
  newUsers: number;
  totalRevenue: number;
  purchaseRevenue: number;
  transactions: number;
  addToCarts: number;
  checkouts: number;
};

function summaryDeltas(current: SummaryLike, previous: SummaryLike) {
  return {
    sessions: deltaOf(current.sessions, previous.sessions),
    engagedSessions: deltaOf(
      current.engagedSessions,
      previous.engagedSessions,
    ),
    userEngagementDuration: deltaOf(
      current.userEngagementDuration,
      previous.userEngagementDuration,
    ),
    screenPageViews: deltaOf(
      current.screenPageViews,
      previous.screenPageViews,
    ),
    eventCount: deltaOf(current.eventCount, previous.eventCount),
    newUsers: deltaOf(current.newUsers, previous.newUsers),
    totalRevenue: deltaOf(current.totalRevenue, previous.totalRevenue),
    purchaseRevenue: deltaOf(
      current.purchaseRevenue,
      previous.purchaseRevenue,
    ),
    transactions: deltaOf(current.transactions, previous.transactions),
    addToCarts: deltaOf(current.addToCarts, previous.addToCarts),
    checkouts: deltaOf(current.checkouts, previous.checkouts),
    engagementRate: deltaOf(
      engagementRateOf(current),
      engagementRateOf(previous),
    ),
    avgEngagementTimePerSession: deltaOf(
      avgEngagementTimeOf(current),
      avgEngagementTimeOf(previous),
    ),
  };
}

export type AnalyticsOverviewResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      totals: ReturnType<typeof summaryDeltas>;
      trends: Array<{
        date: string;
        sessions: number;
        engagementRate: number;
        avgEngagementTimePerSession: number;
        screenPageViews: number;
        eventCount: number;
        newUsers: number;
      }>;
      currencyCode: string | null;
      currencyNote: string;
      newUsersFootnote: string;
      reservedFilterNote: string | null;
    };

async function getOverview(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
}): Promise<AnalyticsOverviewResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const [current, previous, series, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getSummaryTotals(
      input.projectId,
      connection.propertyId,
      windows.current.from,
      windows.current.to,
      connection.currencyCode,
    ),
    Ga4SyncRepository.getSummaryTotals(
      input.projectId,
      connection.propertyId,
      windows.previous.from,
      windows.previous.to,
      connection.currencyCode,
    ),
    Ga4SyncRepository.getDailySummarySeries(
      input.projectId,
      connection.propertyId,
      windows.current.from,
      windows.current.to,
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "summary",
      windows.current.from,
      windows.current.to,
    ),
  ]);

  return {
    connected: true,
    propertyId: connection.propertyId,
    filters: filtersOf(input),
    windows,
    coverage: toCoverage(grainCoverage, days),
    totals: summaryDeltas(current, previous),
    trends: series.map((point) => ({
      date: point.date,
      sessions: point.sessions,
      engagementRate: engagementRateOf(point),
      avgEngagementTimePerSession: avgEngagementTimeOf(point),
      screenPageViews: point.screenPageViews,
      eventCount: point.eventCount,
      newUsers: point.newUsers,
    })),
    currencyCode: connection.currencyCode,
    currencyNote: currencyNoteFor(connection.currencyCode),
    newUsersFootnote: NEW_USERS_FOOTNOTE,
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

type AdditiveRow = {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
};

function rowDeltas(current: AdditiveRow, previous: AdditiveRow) {
  return {
    sessions: deltaOf(current.sessions, previous.sessions),
    engagedSessions: deltaOf(
      current.engagedSessions,
      previous.engagedSessions,
    ),
    engagementRate: deltaOf(
      engagementRateOf(current),
      engagementRateOf(previous),
    ),
    avgEngagementTimePerSession: deltaOf(
      avgEngagementTimeOf(current),
      avgEngagementTimeOf(previous),
    ),
    screenPageViews: deltaOf(
      current.screenPageViews,
      previous.screenPageViews,
    ),
    eventCount: deltaOf(current.eventCount, previous.eventCount),
  };
}

const ZERO_ROW: AdditiveRow = {
  sessions: 0,
  engagedSessions: 0,
  userEngagementDuration: 0,
  screenPageViews: 0,
  eventCount: 0,
};

export type AnalyticsAcquisitionRow = {
  channelGroup: string;
  source: string;
  medium: string;
  isOrganic: boolean;
} & ReturnType<typeof rowDeltas>;

export type AnalyticsAcquisitionResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      rows: AnalyticsAcquisitionRow[];
      newUsersFootnote: string;
      reservedFilterNote: string | null;
    };

async function getAcquisition(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
}): Promise<AnalyticsAcquisitionResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const filter = input.channel ? { channelGroup: input.channel } : {};
  const [currentGroups, previousGroups, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getAcquisitionGroups(
      input.projectId,
      connection.propertyId,
      windows.current.from,
      windows.current.to,
      filter,
    ),
    Ga4SyncRepository.getAcquisitionGroups(
      input.projectId,
      connection.propertyId,
      windows.previous.from,
      windows.previous.to,
      filter,
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "acquisition",
      windows.current.from,
      windows.current.to,
    ),
  ]);

  const previousByKey = new Map(
    previousGroups.map((group) => [acquisitionKey(group), group]),
  );
  const seen = new Set<string>();
  const rows: AnalyticsAcquisitionRow[] = currentGroups.map((group) => {
    const key = acquisitionKey(group);
    seen.add(key);
    return toAcquisitionRow(group, previousByKey.get(key) ?? ZERO_ROW);
  });
  for (const group of previousGroups) {
    const key = acquisitionKey(group);
    if (seen.has(key)) continue;
    rows.push(toAcquisitionRow(ZERO_ACQUISITION_GROUP(group), group));
  }

  return {
    connected: true,
    propertyId: connection.propertyId,
    filters: filtersOf(input),
    windows,
    coverage: toCoverage(grainCoverage, days),
    rows,
    newUsersFootnote: NEW_USERS_FOOTNOTE,
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

function acquisitionKey(group: {
  channelGroup: string;
  source: string;
  medium: string;
}): string {
  return `${group.channelGroup}\n${group.source}\n${group.medium}`;
}

function toAcquisitionRow(
  current: Ga4AcquisitionGroup,
  previous: AdditiveRow,
): AnalyticsAcquisitionRow {
  return {
    channelGroup: current.channelGroup,
    source: current.source,
    medium: current.medium,
    isOrganic: current.channelGroup === ORGANIC_CHANNEL_GROUP,
    ...rowDeltas(current, previous),
  };
}

function ZERO_ACQUISITION_GROUP(group: Ga4AcquisitionGroup): Ga4AcquisitionGroup {
  return { ...ZERO_ROW, ...group, sessions: 0 };
}

export type AnalyticsLandingRow = {
  landingPage: string;
} & ReturnType<typeof rowDeltas>;

export type AnalyticsLandingResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      rows: AnalyticsLandingRow[];
      reservedFilterNote: string | null;
    };

async function getLandingPages(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
  limit: number;
}): Promise<AnalyticsLandingResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  // Landing rows carry no channel dimension; the channel filter is echoed
  // but cannot narrow page rows (documented in the filter contract).
  const [currentGroups, previousGroups, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getLandingGroups(
      input.projectId,
      connection.propertyId,
      windows.current.from,
      windows.current.to,
      { limit: input.limit },
    ),
    Ga4SyncRepository.getLandingGroups(
      input.projectId,
      connection.propertyId,
      windows.previous.from,
      windows.previous.to,
      { limit: input.limit },
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "landing_pages",
      windows.current.from,
      windows.current.to,
    ),
  ]);

  const previousByPage = new Map(
    previousGroups.map((group) => [group.landingPage, group]),
  );
  const seen = new Set<string>();
  const rows: AnalyticsLandingRow[] = currentGroups.map((group) => {
    seen.add(group.landingPage);
    return toLandingRow(group, previousByPage.get(group.landingPage) ?? ZERO_ROW);
  });
  for (const group of previousGroups) {
    if (seen.has(group.landingPage)) continue;
    rows.push(
      toLandingRow(
        { ...group, sessions: 0, engagedSessions: 0, userEngagementDuration: 0, screenPageViews: 0 },
        group,
      ),
    );
  }

  return {
    connected: true,
    propertyId: connection.propertyId,
    filters: filtersOf(input),
    windows,
    coverage: toCoverage(grainCoverage, days),
    rows,
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

function toLandingRow(
  current: Ga4LandingGroup,
  previous: AdditiveRow,
): AnalyticsLandingRow {
  return {
    landingPage: current.landingPage,
    ...rowDeltas(current, previous),
  };
}

export const AnalyticsService = {
  getOverview,
  getAcquisition,
  getLandingPages,
  resolveAnalyticsWindows,
};
