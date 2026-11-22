import type { ColumnDef } from "@tanstack/react-table";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

// Dashboard sync status badges — deliberately independent of rank positions.
const SYNC_STATUS_META: Record<
  string,
  { label: string; className: string; title: string }
> = {
  synced: {
    label: "Synced",
    className: "badge-success",
    title: "Keyword is tracked in the SE Ranking project",
  },
  not_synced: {
    label: "Not Synced",
    className: "badge-ghost border border-base-300 text-base-content/60",
    title: "This keyword is absent from the linked SE Ranking project",
  },
  partial: {
    label: "Partially Synced",
    className: "badge-warning",
    title:
      "Keyword exists in SE Ranking but some tracking engines are missing or unverified",
  },
  failed: {
    label: "Sync Failed",
    className: "badge-error",
    title: "The last sync attempt for this keyword failed",
  },
  unknown: {
    label: "Unknown",
    className: "badge-ghost text-base-content/45",
    title: "Remote state could not be verified for this keyword",
  },
};

export function makeSeRankingSyncColumn(
  statuses: Record<string, string>,
): ColumnDef<RankTrackingRow> {
  return {
    id: "seRankingSync",
    enableSorting: false,
    header: () => (
      <span
        className="text-xs uppercase tracking-wide font-medium text-base-content/60 cursor-help"
        title="Whether this keyword is tracked in the linked SE Ranking project"
      >
        SE Ranking
      </span>
    ),
    size: 110,
    minSize: 90,
    maxSize: 150,
    cell: ({ row }) => {
      const status = statuses[row.original.trackingKeywordId];
      const meta = status ? SYNC_STATUS_META[status] : null;
      if (!meta) return null;
      return (
        <span
          className={`badge badge-xs ${meta.className} whitespace-nowrap`}
          title={meta.title}
          data-testid={`seranking-sync-status-${status}`}
        >
          {meta.label}
        </span>
      );
    },
  };
}
