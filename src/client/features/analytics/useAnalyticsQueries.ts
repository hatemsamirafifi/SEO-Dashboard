import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ORGANIC_CHANNEL_GROUP } from "@/shared/ga4";
import type { AnalyticsRange } from "@/types/schemas/ga4";
import {
  getAnalyticsAcquisition,
  getAnalyticsAudience,
  getAnalyticsConversions,
  getAnalyticsEcommerce,
  getAnalyticsEvents,
  getAnalyticsGeo,
  getAnalyticsLandingPages,
  getAnalyticsOverview,
  getAnalyticsTechnology,
  getGa4Connection,
  getGa4SyncStatus,
  listGa4Goals,
} from "@/serverFunctions/ga4";
import { getSearchPerformanceTable } from "@/serverFunctions/searchPerformance";
import type { CompareMode } from "@/types/schemas/date-range-compare";
import { toDeviceParam } from "./AnalyticsFilterToolbar";
import { toGoalSelectState } from "./analyticsCopy";

export type AnalyticsFilterState = {
  range: AnalyticsRange;
  startDate?: string;
  endDate?: string;
  compareMode?: CompareMode;
  compareStartDate?: string;
  compareEndDate?: string;
  channel: string;
  device: string;
  country: string;
  goalId: string;
};

function buildFilterInput(filters: AnalyticsFilterState) {
  const {
    range,
    startDate,
    endDate,
    compareMode,
    compareStartDate,
    compareEndDate,
    channel,
    device,
    country,
  } = filters;
  const deviceParam = toDeviceParam(device);
  return {
    range,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(compareMode ? { compareMode } : {}),
    ...(compareStartDate ? { compareStartDate } : {}),
    ...(compareEndDate ? { compareEndDate } : {}),
    ...(channel.trim() ? { channel: channel.trim() } : {}),
    ...(deviceParam ? { device: deviceParam } : {}),
    ...(country.trim() ? { country: country.trim() } : {}),
  };
}

/** All Analytics page server reads in one hook (spec 010 extraction: keeps
 *  the page component under complexity/size limits). Queries stay
 *  stored-grains only; the goal filter scopes the conversions read. */
export function useAnalyticsQueries(
  projectId: string,
  filters: AnalyticsFilterState,
  techDimension: "device" | "browser" | "os" = "device",
) {
  const { goalId, compareMode } = filters;
  const filterInput = buildFilterInput(filters);

  const connectionQuery = useQuery({
    queryKey: ["ga4Connection", projectId],
    queryFn: () => getGa4Connection({ data: { projectId } }),
  });
  const syncQuery = useQuery({
    queryKey: ["ga4SyncStatus", projectId],
    queryFn: () => getGa4SyncStatus({ data: { projectId } }),
    enabled: connectionQuery.data?.connected === true,
  });

  const connected = connectionQuery.data?.connected === true;
  const goalsQuery = useQuery({
    queryKey: ["ga4Goals", projectId],
    queryFn: () => listGa4Goals({ data: { projectId } }),
    enabled: connected,
  });
  const goalsState = toGoalSelectState({
    isPending: goalsQuery.isPending,
    isError: goalsQuery.isError,
    goals: goalsQuery.data?.goals ?? [],
  });

  const overviewQuery = useQuery({
    queryKey: ["analyticsOverview", projectId, filterInput],
    queryFn: () =>
      getAnalyticsOverview({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const acquisitionQuery = useQuery({
    queryKey: ["analyticsAcquisition", projectId, filterInput],
    queryFn: () =>
      getAnalyticsAcquisition({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const organicQuery = useQuery({
    queryKey: [
      "analyticsAcquisition",
      projectId,
      { ...filterInput, channel: ORGANIC_CHANNEL_GROUP },
    ],
    queryFn: () =>
      getAnalyticsAcquisition({
        data: {
          projectId,
          ...filterInput,
          channel: ORGANIC_CHANNEL_GROUP,
        },
      }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const landingQuery = useQuery({
    queryKey: ["analyticsLandingPages", projectId, filterInput],
    queryFn: () =>
      getAnalyticsLandingPages({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const eventsQuery = useQuery({
    queryKey: ["analyticsEvents", projectId, filterInput],
    queryFn: () => getAnalyticsEvents({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const conversionsQuery = useQuery({
    queryKey: ["analyticsConversions", projectId, filterInput, goalId],
    queryFn: () =>
      getAnalyticsConversions({
        data: {
          projectId,
          ...filterInput,
          ...(goalId ? { goalId } : {}),
        },
      }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const ecommerceQuery = useQuery({
    queryKey: ["analyticsEcommerce", projectId, filterInput],
    queryFn: () =>
      getAnalyticsEcommerce({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const audienceQuery = useQuery({
    queryKey: ["analyticsAudience", projectId, filterInput],
    queryFn: () =>
      getAnalyticsAudience({ data: { projectId, ...filterInput } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });

  const overviewData = overviewQuery.data;
  const currentFrom =
    overviewData?.connected === true
      ? overviewData.windows.current.from
      : undefined;
  const currentTo =
    overviewData?.connected === true
      ? overviewData.windows.current.to
      : undefined;
  const prevFrom =
    overviewData?.connected === true
      ? overviewData.windows.previous.from
      : undefined;
  const prevTo =
    overviewData?.connected === true
      ? overviewData.windows.previous.to
      : undefined;
  const hasCompare = Boolean(compareMode && compareMode !== "none");

  const geoQuery = useQuery({
    queryKey: ["analyticsGeo", projectId, currentFrom, currentTo],
    queryFn: () =>
      getAnalyticsGeo({
        data: { projectId, from: currentFrom!, to: currentTo! },
      }),
    enabled: connected && Boolean(currentFrom) && Boolean(currentTo),
    placeholderData: keepPreviousData,
  });

  const prevGeoQuery = useQuery({
    queryKey: ["analyticsGeoPrev", projectId, prevFrom, prevTo],
    queryFn: () =>
      getAnalyticsGeo({
        data: { projectId, from: prevFrom!, to: prevTo! },
      }),
    enabled: connected && hasCompare && Boolean(prevFrom) && Boolean(prevTo),
    placeholderData: keepPreviousData,
  });

  const techQuery = useQuery({
    queryKey: [
      "analyticsTechnology",
      projectId,
      currentFrom,
      currentTo,
      techDimension,
    ],
    queryFn: () =>
      getAnalyticsTechnology({
        data: {
          projectId,
          from: currentFrom!,
          to: currentTo!,
          dimension: techDimension,
        },
      }),
    enabled: connected && Boolean(currentFrom) && Boolean(currentTo),
    placeholderData: keepPreviousData,
  });

  const prevTechQuery = useQuery({
    queryKey: [
      "analyticsTechnologyPrev",
      projectId,
      prevFrom,
      prevTo,
      techDimension,
    ],
    queryFn: () =>
      getAnalyticsTechnology({
        data: {
          projectId,
          from: prevFrom!,
          to: prevTo!,
          dimension: techDimension,
        },
      }),
    enabled: connected && hasCompare && Boolean(prevFrom) && Boolean(prevTo),
    placeholderData: keepPreviousData,
  });

  const gscPagesQuery = useQuery({
    queryKey: [
      "searchPerformanceLandingComparison",
      projectId,
      currentFrom,
      currentTo,
    ],
    queryFn: () =>
      getSearchPerformanceTable({
        data: {
          projectId,
          dimension: "page",
          dateRange: "custom",
          startDate: currentFrom,
          endDate: currentTo,
          page: 1,
          pageSize: 100,
        },
      }),
    enabled: connected && Boolean(currentFrom) && Boolean(currentTo),
    placeholderData: keepPreviousData,
  });

  const sectionQueries = [
    overviewQuery,
    acquisitionQuery,
    organicQuery,
    landingQuery,
    eventsQuery,
    conversionsQuery,
    ecommerceQuery,
    audienceQuery,
    geoQuery,
    techQuery,
  ];

  return {
    connected,
    goalsState,
    connectionQuery,
    syncQuery,
    overviewQuery,
    acquisitionQuery,
    organicQuery,
    landingQuery,
    eventsQuery,
    conversionsQuery,
    ecommerceQuery,
    audienceQuery,
    geoQuery,
    prevGeoQuery,
    techQuery,
    prevTechQuery,
    gscPagesQuery,
    isFetching: sectionQueries.some((query) => query.isFetching),
  };
}
