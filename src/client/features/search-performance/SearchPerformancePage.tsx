import { useEffect, useState } from "react";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { TablePagination } from "@/client/components/table/TablePagination";
import { SearchConsoleConnectionCard } from "@/client/features/gsc/SearchConsoleConnectionCard";
import { SearchPerformanceLoadingState } from "@/client/features/search-performance/SearchPerformanceLoadingState";
import {
  DimensionTable,
  exportDimensionRows,
  exportStriking,
  StrikingDistanceTable,
  TotalsCards,
  type ExportTarget,
} from "@/client/features/search-performance/SearchPerformanceParts";
import {
  SearchPerformanceFilterToolbar,
  ALL,
  type Tab,
} from "@/client/features/search-performance/SearchPerformanceFilterToolbar";
import { SearchPerformanceHeader } from "@/client/features/search-performance/SearchPerformanceHeader";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  exportSearchPerformanceTable,
  getSearchPerformanceReport,
  getSearchPerformanceTable,
  triggerSearchPerformanceSync,
} from "@/serverFunctions/searchPerformance";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import {
  SEARCH_PERFORMANCE_DEFAULT_PAGE_SIZE,
  SEARCH_PERFORMANCE_PAGE_SIZES,
  type SearchPerformanceDateRange,
  type SearchPerformanceDevice,
  type SearchPerformanceTableDimension,
} from "@/types/schemas/search-performance";

function tabDimension(tab: Tab): SearchPerformanceTableDimension {
  return tab === "pages" ? "page" : "query";
}

type FilterInput = {
  dateRange: SearchPerformanceDateRange;
  device?: SearchPerformanceDevice;
  country?: string;
};

function buildFilterInput(
  range: SearchPerformanceDateRange,
  device: SearchPerformanceDevice | typeof ALL,
  country: string,
): FilterInput {
  return {
    dateRange: range,
    ...(device === ALL ? {} : { device }),
    ...(country === ALL ? {} : { country }),
  };
}

function tableQueryOptions(
  projectId: string,
  dimension: SearchPerformanceTableDimension,
  page: number,
  pageSize: number,
  filterInput: FilterInput,
) {
  return queryOptions({
    queryKey: [
      "searchPerformanceTable",
      projectId,
      dimension,
      page,
      pageSize,
      filterInput,
    ],
    queryFn: () =>
      getSearchPerformanceTable({
        data: { projectId, dimension, page, pageSize, ...filterInput },
      }),
  });
}

export function SearchPerformancePage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [range, setRange] =
    useState<SearchPerformanceDateRange>("last_28_days");
  const [device, setDevice] = useState<SearchPerformanceDevice | typeof ALL>(
    ALL,
  );
  const [country, setCountry] = useState<string>(ALL);
  const [tab, setTab] = useState<Tab>("striking");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(
    SEARCH_PERFORMANCE_DEFAULT_PAGE_SIZE,
  );
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [tab, range, device, country, pageSize]);

  const filterInput = buildFilterInput(range, device, country);

  const reportQuery = useQuery({
    queryKey: ["searchPerformance", projectId, range, device, country],
    queryFn: async () => {
      const opId = globalTraceStore.startOperation({
        feature: "search_console",
        operation: "search_console.performance",
        source: "Search Performance page",
        projectId,
        status: "running",
        billing: "Free",
        metered: false,
        budget: "PASS",
        cache: "HIT",
        provider: "GSC",
        metadata: { range, device, country },
      });

      try {
        const result = await getSearchPerformanceReport({
          data: { projectId, ...filterInput },
        });

        globalTraceStore.completeOperation(opId, {
          status: "success",
          httpStatus: 200,
          providerCalls: 1,
          providerBreakdown: [{ provider: "GSC", count: 1 }],
          providers: [
            {
              provider: "GSC",
              endpoint: "searchAnalytics/query",
              httpStatus: 200,
              transport: "HTTP",
              billing: "Free",
              metered: false,
              budgetGuard: "PASS",
            },
          ],
        });

        return result;
      } catch (err) {
        globalTraceStore.completeOperation(opId, {
          status: "failed",
          httpStatus: 500,
          errorMessage:
            err instanceof Error
              ? err.message
              : "Failed to fetch search performance",
        });
        throw err;
      }
    },
    placeholderData: keepPreviousData,
  });
  const report = reportQuery.data;

  const executeSync = async (syncRangeOption?: SearchPerformanceDateRange) => {
    if (!report?.connected || isSyncing) return;
    setIsSyncing(true);

    const opId = globalTraceStore.startOperation({
      feature: "search_console",
      operation: syncRangeOption
        ? "gsc.search_performance.sync_range"
        : "gsc.search_performance.manual",
      source: "Search Performance page",
      projectId,
      status: "running",
      billing: "Free",
      metered: false,
      budget: "PASS",
      provider: "GSC",
      metadata: { range: syncRangeOption ?? "missing_dates", device, country },
    });

    try {
      toast.info("Starting Search Console synchronization…");
      const result = await triggerSearchPerformanceSync({
        data: {
          projectId,
          syncType: "manual",
          ...(syncRangeOption ? { dateRange: syncRangeOption } : {}),
        },
      });

      if (result.alreadyRunning) {
        toast.info("A sync is already in progress for this property.");
      } else if (result.status === "completed") {
        toast.success(
          `Sync completed: ${result.rowsInserted} facts updated across ${result.chunksCompleted} chunks.`,
        );
      } else if (result.status === "partial" && !result.error) {
        toast.info(
          `Sync partially completed: ${result.rowsInserted} facts stored through ${result.lastSuccessfulDate ?? "latest available date"}. Recent data is still being finalized by Google.`,
        );
      } else {
        toast.error(
          `Sync finished with status ${result.status}: ${result.error ?? "Failed"}`,
        );
      }

      const isSuccessOrPending =
        result.status === "completed" ||
        (result.status === "partial" && !result.error);

      const callsPerChunk = 6;
      globalTraceStore.completeOperation(opId, {
        status: isSuccessOrPending ? "success" : "failed",
        httpStatus: isSuccessOrPending ? 200 : 500,
        providerCalls: result.chunksCompleted * callsPerChunk,
        providerBreakdown: [
          {
            provider: "Google Search Console",
            count: result.chunksCompleted * callsPerChunk,
          },
        ],
        errorMessage: result.error,
        metadata: {
          syncStatus: result.status,
          rowsFetched: result.rowsFetched,
          rowsInserted: result.rowsInserted,
          chunksCompleted: result.chunksCompleted,
          lastSuccessfulDate: result.lastSuccessfulDate,
        },
      });

      await reportQuery.refetch();
    } catch (error) {
      const message = getStandardErrorMessage(error, "Sync failed");
      toast.error(message);
      globalTraceStore.completeOperation(opId, {
        status: "failed",
        httpStatus: 500,
        errorMessage: message,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncNow = () => executeSync();
  const handleSyncRange = () => executeSync(range);

  const isTableTab = tab === "queries" || tab === "pages";
  const dimension = tabDimension(tab);
  const tableQuery = useQuery({
    ...tableQueryOptions(projectId, dimension, page, pageSize, filterInput),
    enabled: report?.connected === true && isTableTab,
    placeholderData: keepPreviousData,
  });
  const tableData = tableQuery.data;
  const tableRows = tableData?.connected ? tableData.rows : [];
  const hasNextPage = tableData?.connected ? tableData.hasNextPage : false;

  useEffect(() => {
    if (report?.connected !== true) return;
    void queryClient.prefetchQuery(
      tableQueryOptions(
        projectId,
        "query",
        1,
        SEARCH_PERFORMANCE_DEFAULT_PAGE_SIZE,
        buildFilterInput(range, device, country),
      ),
    );
  }, [report?.connected, projectId, range, device, country, queryClient]);

  const handleExport = async (target: ExportTarget) => {
    if (!report?.connected) return;
    try {
      if (tab === "striking") {
        exportStriking(report, target);
        return;
      }
      const data = await exportSearchPerformanceTable({
        data: { projectId, dimension, ...filterInput },
      });
      exportDimensionRows(dimension, data.rows, report.range, target);
    } catch (error) {
      toast.error(getStandardErrorMessage(error, "Export failed"));
    }
  };

  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <SearchPerformanceHeader
          projectId={projectId}
          report={report}
          isSyncing={isSyncing}
          onSyncNow={() => void handleSyncNow()}
          onSyncRange={() => void handleSyncRange()}
        />

        {reportQuery.isPending ? (
          <SearchPerformanceLoadingState />
        ) : reportQuery.isError ? (
          <div className="alert alert-error">
            <span className="text-sm">
              {getStandardErrorMessage(reportQuery.error)}
            </span>
          </div>
        ) : !report?.connected ? (
          <div className="max-w-2xl">
            <SearchConsoleConnectionCard projectId={projectId} />
          </div>
        ) : (
          <>
            <TotalsCards report={report} />
            <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
              <SearchPerformanceFilterToolbar
                tab={tab}
                setTab={setTab}
                strikingCount={report.strikingDistance.length}
                isFetching={reportQuery.isFetching && !reportQuery.isPending}
                device={device}
                setDevice={setDevice}
                country={country}
                setCountry={setCountry}
                countryOptions={report.countries}
                range={range}
                setRange={setRange}
                onExport={(target) => void handleExport(target)}
              />

              {tab === "striking" ? (
                <StrikingDistanceTable
                  projectId={projectId}
                  rows={report.strikingDistance}
                />
              ) : tableQuery.isPending ? (
                <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
              ) : tableQuery.isError ? (
                <div className="p-4">
                  <div className="alert alert-error">
                    <span className="text-sm">
                      {getStandardErrorMessage(tableQuery.error)}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="p-4">
                    <DimensionTable
                      rows={tableRows}
                      keyLabel={tab === "queries" ? "Query" : "Page"}
                    />
                  </div>
                  <TablePagination
                    page={page}
                    pageSize={pageSize}
                    pageSizes={SEARCH_PERFORMANCE_PAGE_SIZES}
                    totalCount={null}
                    hasNextPage={hasNextPage}
                    isLoading={tableQuery.isFetching}
                    onPageChange={setPage}
                    onPageSizeChange={setPageSize}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
