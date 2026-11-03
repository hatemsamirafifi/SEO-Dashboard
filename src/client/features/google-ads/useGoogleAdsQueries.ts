import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getGoogleAdsCampaigns,
  getGoogleAdsConnectionStatus,
  getGoogleAdsDevices,
  getGoogleAdsKeywords,
  getGoogleAdsLandingPages,
  getGoogleAdsOverview,
  getGoogleAdsSearchTerms,
  getGoogleAdsSyncStatus,
} from "@/serverFunctions/google-ads";

/** All Google Ads page server reads in one hook. Every analytics read is a
 *  STORED-DATA read: it must never trigger a provider call during render, so
 *  the breakdowns stay enabled only while the project is connected. */

export type GoogleAdsFilterInput = {
  startDate: string;
  endDate: string;
  /** Restricts the device / landing-page breakdowns to one campaign. */
  campaignResourceId?: string;
  /** Case-insensitive LIKE filter for the search-term breakdown. */
  searchTextLike?: string;
};

export function useGoogleAdsQueries(
  projectId: string,
  filters: GoogleAdsFilterInput,
) {
  const { startDate, endDate } = filters;

  const connectionQuery = useQuery({
    queryKey: ["googleAdsConnection", projectId],
    queryFn: () => getGoogleAdsConnectionStatus({ data: { projectId } }),
  });
  const connected = connectionQuery.data?.connected === true;
  const syncStatusQuery = useQuery({
    queryKey: ["googleAdsSyncStatus", projectId],
    queryFn: () => getGoogleAdsSyncStatus({ data: { projectId } }),
    enabled: connected,
  });

  const criteria = { startDate, endDate };

  const overviewQuery = useQuery({
    queryKey: ["googleAdsOverview", projectId, criteria],
    queryFn: async () => {
      const opId = globalTraceStore.startOperation({
        feature: "google_ads",
        operation: "google_ads.overview",
        source: "Google Ads page",
        projectId,
        status: "running",
        billing: "Free",
        metered: false,
        budget: "PASS",
        cache: "HIT",
        provider: "Google Ads",
        metadata: { ...criteria },
      });
      try {
        const res = await getGoogleAdsOverview({
          data: { projectId, ...criteria },
        });
        globalTraceStore.completeOperation(opId, {
          status: "success",
          httpStatus: 200,
        });
        return res;
      } catch (err) {
        globalTraceStore.completeOperation(opId, {
          status: "failed",
          errorMessage: getStandardErrorMessage(err),
        });
        throw err;
      }
    },
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const campaignsQuery = useQuery({
    queryKey: ["googleAdsCampaigns", projectId, criteria],
    queryFn: () => getGoogleAdsCampaigns({ data: { projectId, ...criteria } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const keywordsQuery = useQuery({
    queryKey: ["googleAdsKeywords", projectId, criteria],
    queryFn: () => getGoogleAdsKeywords({ data: { projectId, ...criteria } }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const searchTermsQuery = useQuery({
    queryKey: [
      "googleAdsSearchTerms",
      projectId,
      { ...criteria, searchTextLike: filters.searchTextLike },
    ],
    queryFn: () =>
      getGoogleAdsSearchTerms({
        data: {
          projectId,
          ...criteria,
          ...(filters.searchTextLike
            ? { searchTextLike: filters.searchTextLike }
            : {}),
        },
      }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const devicesQuery = useQuery({
    queryKey: [
      "googleAdsDevices",
      projectId,
      { ...criteria, campaignResourceId: filters.campaignResourceId },
    ],
    queryFn: () =>
      getGoogleAdsDevices({
        data: {
          projectId,
          ...criteria,
          ...(filters.campaignResourceId
            ? { campaignResourceId: filters.campaignResourceId }
            : {}),
        },
      }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });
  const landingPagesQuery = useQuery({
    queryKey: [
      "googleAdsLandingPages",
      projectId,
      { ...criteria, campaignResourceId: filters.campaignResourceId },
    ],
    queryFn: () =>
      getGoogleAdsLandingPages({
        data: {
          projectId,
          ...criteria,
          ...(filters.campaignResourceId
            ? { campaignResourceId: filters.campaignResourceId }
            : {}),
        },
      }),
    enabled: connected,
    placeholderData: keepPreviousData,
  });

  const connectedQueries = [
    overviewQuery,
    campaignsQuery,
    keywordsQuery,
    searchTermsQuery,
    devicesQuery,
    landingPagesQuery,
  ];

  return {
    connectionQuery,
    syncStatusQuery,
    overviewQuery,
    campaignsQuery,
    keywordsQuery,
    searchTermsQuery,
    devicesQuery,
    landingPagesQuery,
    connected,
    isFetchingSome:
      connectedQueries.some((query) => query.isFetching) &&
      !overviewQuery.isPending,
  };
}
