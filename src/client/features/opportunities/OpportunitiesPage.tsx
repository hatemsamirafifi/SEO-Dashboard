import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { listOpportunities } from "@/serverFunctions/opportunities";
import {
  applyClientFilters,
  OPPORTUNITY_PRIORITIES,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TYPES,
  PRIORITY_META,
  priorityBadgeClass,
  priorityLabel,
  STATUS_META,
  statusBadgeClass,
  statusLabel,
  toOpportunitiesPageView,
  TYPE_META,
  typeLabel,
  formatDateTime,
  formatMissInfo,
  type OpportunityStatus,
} from "@/client/features/opportunities/opportunitiesCopy";

type StatusTab = OpportunityStatus | "all";

const TAB_OPTIONS: Array<{ value: StatusTab; label: string }> = [
  { value: "all", label: "All" },
  ...OPPORTUNITY_STATUSES.map((status) => ({
    value: status as StatusTab,
    label: STATUS_META[status].label,
  })),
];

type ListRow = Awaited<
  ReturnType<typeof listOpportunities>
>["opportunities"][number];

function OpportunityRowCard({
  row,
  projectId,
}: {
  row: ListRow;
  projectId: string;
}) {
  const missInfo = formatMissInfo({
    consecutiveMisses: row.consecutiveMisses,
    stale: row.stale,
  });
  return (
    <Link
      to="/p/$projectId/opportunities/$opportunityId"
      params={{ projectId, opportunityId: row.id }}
      className="block rounded-xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-primary/50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={priorityBadgeClass(row.priority)}>
          {priorityLabel(row.priority)}
        </span>
        <span className={statusBadgeClass(row.status)}>
          {statusLabel(row.status)}
        </span>
        <span className="badge badge-outline badge-sm">
          {typeLabel(row.type)}
        </span>
        {row.stale ? (
          <span className="badge badge-error badge-sm">Stale</span>
        ) : null}
      </div>
      <h2 className="mt-2 font-semibold">{row.title}</h2>
      <p className="mt-1 line-clamp-2 text-sm text-base-content/70">
        {row.explanationFact}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-base-content/60">
        <span>
          Impact{" "}
          <strong className="text-base-content">{row.impactScore}</strong>
        </span>
        <span>
          Confidence{" "}
          <strong className="text-base-content">{row.confidenceScore}</strong>
        </span>
        {row.keyword ? <span>Keyword: {row.keyword}</span> : null}
        {row.page ? <span className="truncate">Page: {row.page}</span> : null}
        <span>Seen {formatDateTime(row.lastDetectedAt)}</span>
        {missInfo ? <span className="text-warning">{missInfo}</span> : null}
      </div>
    </Link>
  );
}

export function OpportunitiesPage({ projectId }: { projectId: string }) {
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const listQuery = useQuery({
    queryKey: [
      "opportunities",
      projectId,
      statusTab === "all" ? null : statusTab,
      typeFilter === "all" ? null : typeFilter,
    ],
    queryFn: () =>
      listOpportunities({
        data: {
          projectId,
          ...(statusTab === "all" ? {} : { status: statusTab }),
          ...(typeFilter === "all" ? {} : { type: typeFilter }),
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = listQuery.data?.opportunities ?? [];
  const filtered = applyClientFilters(rows, {
    types: [],
    priorities: priorityFilter === "all" ? [] : [priorityFilter],
    search,
  });
  const view = toOpportunitiesPageView({
    isPending: listQuery.isPending,
    isError: listQuery.isError,
    totalCount: rows.length,
    filteredCount: filtered.length,
  });
  const isFiltering =
    statusTab !== "all" ||
    typeFilter !== "all" ||
    priorityFilter !== "all" ||
    search.trim() !== "";
  const clearFilters = () => {
    setStatusTab("all");
    setTypeFilter("all");
    setPriorityFilter("all");
    setSearch("");
  };

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Opportunities</h1>
          <p className="text-sm text-base-content/60">
            Actionable findings from intelligence scans, scored by impact and
            confidence. Detections refresh automatically on schedule.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
          <div className="border-b border-base-300 p-4">
            <div
              role="tablist"
              aria-label="Filter by status"
              className="tabs tabs-border"
            >
              {TAB_OPTIONS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  aria-selected={statusTab === tab.value}
                  className={`tab ${statusTab === tab.value ? "tab-active" : ""}`}
                  onClick={() => setStatusTab(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <select
                aria-label="Filter by type"
                className="select select-bordered select-sm"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                {OPPORTUNITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_META[type].label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by priority"
                className="select select-bordered select-sm"
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
              >
                <option value="all">All priorities</option>
                {OPPORTUNITY_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_META[priority].label}
                  </option>
                ))}
              </select>
              <input
                type="search"
                aria-label="Search opportunities"
                className="input input-bordered input-sm w-full max-w-xs"
                placeholder="Search keyword, page, or title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {isFiltering ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>

          <div className="space-y-3 p-4">
            {view.kind === "loading" ? (
              <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
                <Loader2 className="size-4 animate-spin" /> Loading
                opportunities…
              </div>
            ) : view.kind === "error" ? (
              <div className="alert alert-error">
                <span className="text-sm">
                  {getStandardErrorMessage(
                    listQuery.error,
                    "Failed to load opportunities",
                  )}
                </span>
              </div>
            ) : view.kind === "empty" ? (
              <div className="rounded-xl border border-base-300 bg-base-100 p-6">
                <h2 className="font-semibold">No opportunities yet</h2>
                <p className="mt-1 text-sm text-base-content/60">
                  Intelligence scans run automatically on schedule. New findings
                  appear here once detectors observe them.
                </p>
              </div>
            ) : view.kind === "filtered-empty" ? (
              <div className="rounded-xl border border-base-300 bg-base-100 p-6">
                <h2 className="font-semibold">No matches</h2>
                <p className="mt-1 text-sm text-base-content/60">
                  No opportunities match the current filters.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-3"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <>
                {listQuery.isFetching ? (
                  <div className="flex items-center gap-2 text-sm text-base-content/60">
                    <Loader2 className="size-4 animate-spin" /> Refreshing…
                  </div>
                ) : null}
                {filtered.map((row) => (
                  <OpportunityRowCard
                    key={row.id}
                    row={row}
                    projectId={projectId}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
