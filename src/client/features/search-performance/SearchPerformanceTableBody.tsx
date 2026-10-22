import { Loader2 } from "lucide-react";
import { TablePagination } from "@/client/components/table/TablePagination";
import {
  DimensionTable,
  StrikingDistanceTable,
} from "@/client/features/search-performance/SearchPerformanceParts";
import type { Tab } from "@/client/features/search-performance/SearchPerformanceFilterToolbar";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  SEARCH_PERFORMANCE_PAGE_SIZES,
  type SearchPerformanceDimensionRowResult,
  type SearchPerformanceStrikingRow,
} from "@/types/schemas/search-performance";

type TableQueryState = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  rows: SearchPerformanceDimensionRowResult[];
  hasNextPage: boolean;
  isFetching: boolean;
};

/**
 * The table body of the search-performance page: the striking-distance table
 * for the striking tab, otherwise the dimension table with pagination.
 */
export function SearchPerformanceTableBody({
  projectId,
  tab,
  strikingRows,
  table,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  projectId: string;
  tab: Tab;
  strikingRows: SearchPerformanceStrikingRow[];
  table: TableQueryState;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  if (tab === "striking") {
    return <StrikingDistanceTable projectId={projectId} rows={strikingRows} />;
  }

  if (table.isPending) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (table.isError) {
    return (
      <div className="p-4">
        <div className="alert alert-error">
          <span className="text-sm">
            {getStandardErrorMessage(table.error)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="p-4">
        <DimensionTable
          rows={table.rows}
          keyLabel={tab === "queries" ? "Query" : "Page"}
        />
      </div>
      <TablePagination
        page={page}
        pageSize={pageSize}
        pageSizes={SEARCH_PERFORMANCE_PAGE_SIZES}
        totalCount={null}
        hasNextPage={table.hasNextPage}
        isLoading={table.isFetching}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </>
  );
}
