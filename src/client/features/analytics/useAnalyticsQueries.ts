import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ORGANIC_CHANNEL_GROUP } from "@/shared/ga4";
import type { AnalyticsRange } from "@/types/schemas/ga4";
import {
  getAnalyticsAcquisition,
  getAnalyticsAudience,
  getAnalyticsConversions,
  getAnalyticsEcommerce,
  getAnalyticsEvents,
  getAnalyticsLandingPages,
  getAnalyticsOverview,
  getGa4Connection,
  getGa4SyncStatus,
  listGa4Goals,
} from "@/serverFunctions/ga4";
import { toDeviceParam } from "./AnalyticsFilterToolbar";
import { toGoalSelectState } from "./analyticsCopy";

export type AnalyticsFilterState = {
  range: AnalyticsRange;
  channel: string;
  device: string;
  country: string;
  goalId: string;
};

function buildFilterInput(
  range: AnalyticsRange,
  channel: string,
  device: string,
  country: string,
) {
  const deviceParam = toDeviceParam(device);
  return {
    range,
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
) {
  const { range, channel, device, country, goalId } = filters;
  const filterInput = buildFilterInput(range, channel, device, country);

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

  const sectionQueries = [
    overviewQuery,
    acquisitionQuery,
    organicQuery,
    landingQuery,
    eventsQuery,
    conversionsQuery,
    ecommerceQuery,
    audienceQuery,
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
    isFetching: sectionQueries.some((query) => query.isFetching),
  };
}
