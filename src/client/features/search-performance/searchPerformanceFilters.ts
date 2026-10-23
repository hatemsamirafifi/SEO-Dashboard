import { queryOptions } from "@tanstack/react-query";
import { getSearchPerformanceTable } from "@/serverFunctions/searchPerformance";
import {
  ALL,
  type Tab,
} from "@/client/features/search-performance/SearchPerformanceFilterToolbar";
import {
  type SearchPerformanceDateRange,
  type SearchPerformanceDevice,
  type SearchPerformanceTableDimension,
} from "@/types/schemas/search-performance";
import type { CompareMode } from "@/types/schemas/date-range-compare";

type FilterInput = {
  dateRange: SearchPerformanceDateRange;
  startDate?: string;
  endDate?: string;
  compareMode: CompareMode;
  compareStartDate?: string;
  compareEndDate?: string;
  device?: SearchPerformanceDevice;
  country?: string;
};

export function tabDimension(tab: Tab): SearchPerformanceTableDimension {
  return tab === "pages" ? "page" : "query";
}

export function buildFilterInput(input: {
  range: SearchPerformanceDateRange;
  startDate: string | undefined;
  endDate: string | undefined;
  compareMode: CompareMode;
  compareStartDate: string | undefined;
  compareEndDate: string | undefined;
  device: SearchPerformanceDevice | typeof ALL;
  country: string;
}): FilterInput {
  const {
    range,
    startDate,
    endDate,
    compareMode,
    compareStartDate,
    compareEndDate,
    device,
    country,
  } = input;
  return {
    dateRange: range,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    compareMode,
    ...(compareStartDate ? { compareStartDate } : {}),
    ...(compareEndDate ? { compareEndDate } : {}),
    ...(device === ALL ? {} : { device }),
    ...(country === ALL ? {} : { country }),
  };
}

export function tableQueryOptions(
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
