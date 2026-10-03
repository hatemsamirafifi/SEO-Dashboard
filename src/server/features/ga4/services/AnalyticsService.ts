/* eslint-disable max-lines */
import { ORGANIC_CHANNEL_GROUP } from "@/shared/ga4";
import { ANALYTICS_RANGE_DAYS, type AnalyticsRange } from "@/types/schemas/ga4";
import { AppError } from "@/server/lib/errors";
import { Ga4ConnectionRepository } from "../repositories/Ga4ConnectionRepository";
import { Ga4GoalRepository } from "../repositories/Ga4GoalRepository";
import {
  NEW_USERS_FOOTNOTE,
  Ga4SyncRepository,
  type Ga4AcquisitionGroup,
  type Ga4EventGroup,
  type Ga4GeoGroup,
  type Ga4GrainCoverage,
  type Ga4LandingGroup,
  type Ga4TechnologyDimension,
  type Ga4TechnologyGroup,
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
  // Spec 010: echoed when a goal filter is applied (validates through the
  // Zod analyticsFilterShape goalId).
  goalId?: string;
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
    status:
      covered >= totalDates ? "complete" : covered > 0 ? "partial" : "none",
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
    `${parts.join(" and ")} accepted but not applied to this table: stored ` +
    `device/country breakdowns live in the geo/technology grain reads. ` +
    `Totals reflect the full property.`
  );
}

function filtersOf(input: {
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
  goalId?: string;
}): AnalyticsFilters {
  return {
    range: input.range,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.device ? { device: input.device } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.goalId ? { goalId: input.goalId } : {}),
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
    engagedSessions: deltaOf(current.engagedSessions, previous.engagedSessions),
    userEngagementDuration: deltaOf(
      current.userEngagementDuration,
      previous.userEngagementDuration,
    ),
    screenPageViews: deltaOf(current.screenPageViews, previous.screenPageViews),
    eventCount: deltaOf(current.eventCount, previous.eventCount),
    newUsers: deltaOf(current.newUsers, previous.newUsers),
    totalRevenue: deltaOf(current.totalRevenue, previous.totalRevenue),
    purchaseRevenue: deltaOf(current.purchaseRevenue, previous.purchaseRevenue),
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
  if (input.country ?? input.device) {
    return getScopedOverview(input, connection, windows, days);
  }
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

/** Grain-grouped rows collapse to summary shape for scoped overview totals.
 *  Revenue/conversion keys are summary-grain-only (the geo/technology grains
 *  store the six engagement metrics) and stay zero with the filter note
 *  carrying that scope. */
function grainGroupToSummary(group: {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
  newUsers: number;
} | null): SummaryLike {
  return {
    sessions: group?.sessions ?? 0,
    engagedSessions: group?.engagedSessions ?? 0,
    userEngagementDuration: group?.userEngagementDuration ?? 0,
    screenPageViews: group?.screenPageViews ?? 0,
    eventCount: group?.eventCount ?? 0,
    newUsers: group?.newUsers ?? 0,
    totalRevenue: 0,
    purchaseRevenue: 0,
    transactions: 0,
    addToCarts: 0,
    checkouts: 0,
  };
}

type ScopedOverviewInput = {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
};

/** Overview totals scoped to the stored geo/technology grains. Country takes
 *  precedence when both filters are set (no cross-grain join exists for a
 *  country×device cell); the unapplied filter is named in the note. Zero
 *  coverage yields coverage "none" plus an explicit note — never
 *  zero-presented-as-data. */
async function getScopedOverview(
  input: ScopedOverviewInput,
  connection: { propertyId: string; currencyCode: string | null },
  windows: AnalyticsWindows,
  days: number,
): Promise<AnalyticsOverviewResult> {
  const notes: string[] = [];
  let current: SummaryLike;
  let previous: SummaryLike;
  let grainCoverage: Ga4GrainCoverage;
  if (input.country) {
    const [currentGroups, previousGroups, coverage] = await Promise.all([
      Ga4SyncRepository.getGeoGroups(
        input.projectId,
        connection.propertyId,
        windows.current.from,
        windows.current.to,
      ),
      Ga4SyncRepository.getGeoGroups(
        input.projectId,
        connection.propertyId,
        windows.previous.from,
        windows.previous.to,
      ),
      Ga4SyncRepository.getGrainCoverage(
        input.projectId,
        connection.propertyId,
        "geo",
        windows.current.from,
        windows.current.to,
      ),
    ]);
    const currentGroup =
      currentGroups.find((group) => group.country === input.country) ?? null;
    const previousGroup =
      previousGroups.find((group) => group.country === input.country) ?? null;
    current = grainGroupToSummary(currentGroup);
    previous = grainGroupToSummary(previousGroup);
    grainCoverage = coverage;
    if (coverage.coveredDates.length === 0) {
      notes.push(
        `No geo coverage for this period: country "${input.country}" shows no data.`,
      );
    } else if (!currentGroup && !previousGroup) {
      notes.push(
        `Country "${input.country}" has no recorded sessions in this period.`,
      );
    }
    if (input.device) {
      notes.push(
        `Device "${input.device}" is not applied to country-scoped totals: no stored country/device join exists.`,
      );
    }
  } else {
    const [currentGroups, previousGroups, coverage] = await Promise.all([
      Ga4SyncRepository.getTechnologyGroups(
        input.projectId,
        connection.propertyId,
        windows.current.from,
        windows.current.to,
        { dimension: "device" },
      ),
      Ga4SyncRepository.getTechnologyGroups(
        input.projectId,
        connection.propertyId,
        windows.previous.from,
        windows.previous.to,
        { dimension: "device" },
      ),
      Ga4SyncRepository.getGrainCoverage(
        input.projectId,
        connection.propertyId,
        "technology",
        windows.current.from,
        windows.current.to,
      ),
    ]);
    const currentGroup =
      currentGroups.find((group) => group.value === input.device) ?? null;
    const previousGroup =
      previousGroups.find((group) => group.value === input.device) ?? null;
    current = grainGroupToSummary(currentGroup);
    previous = grainGroupToSummary(previousGroup);
    grainCoverage = coverage;
    if (coverage.coveredDates.length === 0) {
      notes.push(
        `No technology coverage for this period: device "${input.device}" shows no data.`,
      );
    } else if (!currentGroup && !previousGroup) {
      notes.push(
        `Device "${input.device}" has no recorded sessions in this period.`,
      );
    }
  }

  const todaySeries: Array<{
    date: string;
    sessions: number;
    engagementRate: number;
    avgEngagementTimePerSession: number;
    screenPageViews: number;
    eventCount: number;
    newUsers: number;
  }> = [];
  return {
    connected: true,
    propertyId: connection.propertyId,
    filters: filtersOf(input),
    windows,
    coverage: toCoverage(grainCoverage, days),
    totals: summaryDeltas(current, previous),
    trends: todaySeries,
    currencyCode: connection.currencyCode,
    currencyNote: currencyNoteFor(connection.currencyCode),
    newUsersFootnote: NEW_USERS_FOOTNOTE,
    reservedFilterNote: notes.length > 0 ? notes.join(" ") : null,
  };
}

function inclusiveDayCount(from: string, to: string): number {
  const days =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export type AnalyticsGeoRow = Ga4GeoGroup;

export type AnalyticsGeoResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      from: string;
      to: string;
      coverage: AnalyticsCoverage;
      rows: AnalyticsGeoRow[];
      emptyNote: string | null;
    };

/** Country breakdown from the stored geo grain (DB-first; no live API reads
 *  at render). SUCCESS_*-covered dates only — failed dates are excluded by
 *  the repository join, uncovered windows return zero rows with an explicit
 *  empty state instead of zero-filled rows. */
async function getAnalyticsGeo(input: {
  projectId: string;
  organizationId: string;
  from: string;
  to: string;
}): Promise<AnalyticsGeoResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };
  const [rows, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getGeoGroups(
      input.projectId,
      connection.propertyId,
      input.from,
      input.to,
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "geo",
      input.from,
      input.to,
    ),
  ]);
  return {
    connected: true,
    propertyId: connection.propertyId,
    from: input.from,
    to: input.to,
    coverage: toCoverage(grainCoverage, inclusiveDayCount(input.from, input.to)),
    rows,
    emptyNote:
      rows.length === 0
        ? grainCoverage.coveredDates.length === 0
          ? "No geo data for this period: sync a window with geo coverage or wait for the next scheduled sync."
          : "No countries recorded sessions in this covered period."
        : null,
  };
}

export type AnalyticsTechnologyRow = Ga4TechnologyGroup;

export type AnalyticsTechnologyResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      dimension: Ga4TechnologyDimension;
      from: string;
      to: string;
      coverage: AnalyticsCoverage;
      rows: AnalyticsTechnologyRow[];
      emptyNote: string | null;
    };

/** Device/browser/OS breakdown from the stored technology grain. Same
 *  coverage honesty as getAnalyticsGeo; single-dimension reads aggregate
 *  only additive metrics per value. */
async function getAnalyticsTechnology(input: {
  projectId: string;
  organizationId: string;
  from: string;
  to: string;
  dimension: Ga4TechnologyDimension;
}): Promise<AnalyticsTechnologyResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };
  const [rows, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getTechnologyGroups(
      input.projectId,
      connection.propertyId,
      input.from,
      input.to,
      { dimension: input.dimension },
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "technology",
      input.from,
      input.to,
    ),
  ]);
  return {
    connected: true,
    propertyId: connection.propertyId,
    dimension: input.dimension,
    from: input.from,
    to: input.to,
    coverage: toCoverage(
      grainCoverage,
      inclusiveDayCount(input.from, input.to),
    ),
    rows,
    emptyNote:
      rows.length === 0
        ? grainCoverage.coveredDates.length === 0
          ? `No technology data for this period: sync a window with technology coverage or wait for the next scheduled sync.`
          : "No devices, browsers, or systems recorded sessions in this covered period."
        : null,
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
    engagedSessions: deltaOf(current.engagedSessions, previous.engagedSessions),
    engagementRate: deltaOf(
      engagementRateOf(current),
      engagementRateOf(previous),
    ),
    avgEngagementTimePerSession: deltaOf(
      avgEngagementTimeOf(current),
      avgEngagementTimeOf(previous),
    ),
    screenPageViews: deltaOf(current.screenPageViews, previous.screenPageViews),
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

function ZERO_ACQUISITION_GROUP(
  group: Ga4AcquisitionGroup,
): Ga4AcquisitionGroup {
  return { ...ZERO_ROW, ...group, sessions: 0 };
}

export type AnalyticsLandingRow = {
  landingPage: string;
} & ReturnType<typeof landingRowDeltas>;

type LandingAdditiveRow = {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
};

/** Landing deltas exclude eventCount: the landing grain stores no per-event
 *  metric (§9.3 `ga4_daily_landing_pages`), so page rows must never claim
 *  one. Ratios derive from summed components at query time (§9.4). */
function landingRowDeltas(
  current: LandingAdditiveRow,
  previous: LandingAdditiveRow,
) {
  return {
    sessions: deltaOf(current.sessions, previous.sessions),
    engagedSessions: deltaOf(current.engagedSessions, previous.engagedSessions),
    engagementRate: deltaOf(
      engagementRateOf(current),
      engagementRateOf(previous),
    ),
    avgEngagementTimePerSession: deltaOf(
      avgEngagementTimeOf(current),
      avgEngagementTimeOf(previous),
    ),
    screenPageViews: deltaOf(current.screenPageViews, previous.screenPageViews),
  };
}

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
    return toLandingRow(
      group,
      previousByPage.get(group.landingPage) ?? ZERO_ROW,
    );
  });
  for (const group of previousGroups) {
    if (seen.has(group.landingPage)) continue;
    rows.push(
      toLandingRow(
        {
          ...group,
          sessions: 0,
          engagedSessions: 0,
          userEngagementDuration: 0,
          screenPageViews: 0,
        },
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
  previous: LandingAdditiveRow,
): AnalyticsLandingRow {
  return {
    landingPage: current.landingPage,
    ...landingRowDeltas(current, previous),
  };
}

export type AnalyticsEventRow = {
  eventName: string;
  isKeyEvent: boolean;
  eventCount: MetricDelta;
};

export type AnalyticsEventsResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      rows: AnalyticsEventRow[];
      reservedFilterNote: string | null;
    };

export type AnalyticsConversionsResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      rows: AnalyticsEventRow[];
      goalSelectionDeferredNote: string | null;
      reservedFilterNote: string | null;
    };

const GOAL_SELECTION_DEFERRED_NOTE =
  "Conversions are a read-only key-event list; in-app goal selection is deferred.";

function toEventRow(
  current: Ga4EventGroup,
  previousCount: number,
): AnalyticsEventRow {
  return {
    eventName: current.eventName,
    isKeyEvent: current.isKeyEvent,
    eventCount: deltaOf(current.eventCount, previousCount),
  };
}

async function getEventRows(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
  limit: number;
  keyEventsOnly: boolean;
}): Promise<
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      rows: AnalyticsEventRow[];
      reservedFilterNote: string | null;
    }
> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const [currentGroups, previousGroups, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getEventGroups(
      input.projectId,
      connection.propertyId,
      windows.current.from,
      windows.current.to,
      { limit: input.limit, keyEventsOnly: input.keyEventsOnly },
    ),
    Ga4SyncRepository.getEventGroups(
      input.projectId,
      connection.propertyId,
      windows.previous.from,
      windows.previous.to,
      { limit: input.limit, keyEventsOnly: input.keyEventsOnly },
    ),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "events",
      windows.current.from,
      windows.current.to,
    ),
  ]);

  const previousByName = new Map(
    previousGroups.map((group) => [group.eventName, group.eventCount]),
  );
  const seen = new Set<string>();
  const rows: AnalyticsEventRow[] = currentGroups.map((group) => {
    seen.add(group.eventName);
    return toEventRow(group, previousByName.get(group.eventName) ?? 0);
  });
  for (const group of previousGroups) {
    if (seen.has(group.eventName)) continue;
    rows.push(
      toEventRow(
        { ...group, eventCount: 0, isKeyEvent: group.isKeyEvent },
        group.eventCount,
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

async function getEvents(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
  limit: number;
}): Promise<AnalyticsEventsResult> {
  return getEventRows({ ...input, keyEventsOnly: false });
}

async function getConversions(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
  limit: number;
  // Spec 010: when present, conversions scope to this goal's stored event
  // binding (additive event-count sums, never user sums — P23). Unknown,
  // archived, or other-project goals fail closed (NOT_FOUND, never silent
  // empty — P9).
  goalId?: string;
}): Promise<AnalyticsConversionsResult> {
  if (!input.goalId) {
    const result = await getEventRows({ ...input, keyEventsOnly: true });
    if (!result.connected) return result;
    return {
      ...result,
      goalSelectionDeferredNote: GOAL_SELECTION_DEFERRED_NOTE,
    };
  }
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };
  const goal = await Ga4GoalRepository.getByIdForProject(
    input.goalId,
    input.projectId,
    input.organizationId,
  );
  if (!goal || goal.archivedAt) {
    throw new AppError(
      "NOT_FOUND",
      "Goal not found (unknown, archived, or another project)",
    );
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const [current, previous, grainCoverage] = await Promise.all([
    Ga4SyncRepository.getGoalConversions({
      projectId: input.projectId,
      propertyId: connection.propertyId,
      eventName: goal.eventName,
      matchKeyEventOnly: goal.matchKeyEventOnly,
      from: windows.current.from,
      to: windows.current.to,
    }),
    Ga4SyncRepository.getGoalConversions({
      projectId: input.projectId,
      propertyId: connection.propertyId,
      eventName: goal.eventName,
      matchKeyEventOnly: goal.matchKeyEventOnly,
      from: windows.previous.from,
      to: windows.previous.to,
    }),
    Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "events",
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
    rows: [
      {
        eventName: goal.eventName,
        isKeyEvent: current.isKeyEvent,
        eventCount: deltaOf(current.conversions, previous.conversions),
      },
    ],
    goalSelectionDeferredNote: null,
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

export type AnalyticsEcommerceResult =
  | { connected: false }
  | { connected: true; available: false; propertyId: string }
  | {
      connected: true;
      available: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      totals: {
        totalRevenue: MetricDelta;
        purchaseRevenue: MetricDelta;
        transactions: MetricDelta;
        addToCarts: MetricDelta;
        checkouts: MetricDelta;
      };
      currencyCode: string | null;
      currencyNote: string;
      reservedFilterNote: string | null;
    };

async function getEcommerce(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
}): Promise<AnalyticsEcommerceResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };
  // Conditional section: hidden without the capability latch — never
  // misleading zeros (§9.6). The latch is set by the sync engine on
  // observed revenue.
  if (!connection.hasEcommerce) {
    return {
      connected: true,
      available: false,
      propertyId: connection.propertyId,
    };
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const [current, previous, grainCoverage] = await Promise.all([
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
    available: true,
    propertyId: connection.propertyId,
    filters: filtersOf(input),
    windows,
    coverage: toCoverage(grainCoverage, days),
    totals: {
      totalRevenue: deltaOf(current.totalRevenue, previous.totalRevenue),
      purchaseRevenue: deltaOf(
        current.purchaseRevenue,
        previous.purchaseRevenue,
      ),
      transactions: deltaOf(current.transactions, previous.transactions),
      addToCarts: deltaOf(current.addToCarts, previous.addToCarts),
      checkouts: deltaOf(current.checkouts, previous.checkouts),
    },
    currencyCode: connection.currencyCode,
    currencyNote: currencyNoteFor(connection.currencyCode),
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

export type AnalyticsAudienceResult =
  | { connected: false }
  | {
      connected: true;
      propertyId: string;
      filters: AnalyticsFilters;
      windows: AnalyticsWindows;
      coverage: AnalyticsCoverage;
      totals: { newUsers: MetricDelta };
      newUsersFootnote: string;
      geoTechDeferredNote: string;
      distinctUsersNote: string;
      reservedFilterNote: string | null;
    };

const GEO_TECH_DEFERRED_NOTE =
  "Device and country breakdowns are served by the geo/technology grain reads; audience totals reflect the full property and stay deferred from device/country filtering.";
const DISTINCT_USERS_NOTE =
  "Total and active users are distinct counts and are never summed; exact period values come from the getPeriodUsers query.";

async function getAudience(input: {
  projectId: string;
  organizationId: string;
  range: AnalyticsRange;
  channel?: string;
  device?: string;
  country?: string;
}): Promise<AnalyticsAudienceResult> {
  const connection = await requireConnection(
    input.projectId,
    input.organizationId,
  );
  if (!connection) return { connected: false };

  const todayIso = new Date().toISOString().slice(0, 10);
  const windows = resolveAnalyticsWindows(input.range, todayIso);
  const days = ANALYTICS_RANGE_DAYS[input.range];
  const [current, previous, grainCoverage] = await Promise.all([
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
    totals: { newUsers: deltaOf(current.newUsers, previous.newUsers) },
    newUsersFootnote: NEW_USERS_FOOTNOTE,
    geoTechDeferredNote: GEO_TECH_DEFERRED_NOTE,
    distinctUsersNote: DISTINCT_USERS_NOTE,
    reservedFilterNote: reservedFilterNoteFor(input),
  };
}

export const AnalyticsService = {
  getOverview,
  getAcquisition,
  getLandingPages,
  getEvents,
  getConversions,
  getEcommerce,
  getAudience,
  getAnalyticsGeo,
  getAnalyticsTechnology,
  resolveAnalyticsWindows,
};
