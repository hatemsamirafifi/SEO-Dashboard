import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getNextActions } from "@/serverFunctions/opportunities";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  formatDateTime,
  priorityBadgeClass,
  priorityLabel,
  statusBadgeClass,
  statusLabel,
  typeLabel,
} from "@/client/features/opportunities/opportunitiesCopy";

type Snapshot = Awaited<ReturnType<typeof getNextActions>>;
type Row = Snapshot["critical"][number];

/**
 * Next Actions (spec 021): the unified action center over stored
 * opportunities — no second engine, no recomputed heuristics. Four views
 * (critical / recent / completed / reopened), honest counts, explicit
 * loading/empty states; every row links to the existing opportunity detail.
 */

function ViewList({ rows, projectId }: { rows: Row[]; projectId: string }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to="/p/$projectId/opportunities/$opportunityId"
            params={{ projectId, opportunityId: row.id }}
            className="block rounded-xl border border-base-300 bg-base-100 p-3 transition-colors hover:border-primary/50"
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
            </div>
            <span className="mt-1 block font-medium">{row.title}</span>
            <span className="mt-0.5 block text-xs text-base-content/60">
              Impact {row.impactScore} · Confidence {row.confidenceScore} · Seen{" "}
              {formatDateTime(row.lastDetectedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ViewBlock({
  title,
  count,
  rows,
  projectId,
}: {
  title: string;
  count: number;
  rows: Row[];
  projectId: string;
}) {
  return (
    <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">
          {title}
          <span className="ml-2 badge badge-ghost badge-sm">{count}</span>
        </h3>
        <Link
          to="/p/$projectId/opportunities"
          params={{ projectId }}
          className="link link-hover text-sm"
          aria-label={`Open ${title.toLowerCase()} in the full list`}
        >
          View all
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-base-content/60">
          Nothing here right now.
        </p>
      ) : (
        <div className="mt-2">
          <ViewList rows={rows} projectId={projectId} />
        </div>
      )}
    </div>
  );
}

export function NextActionsSection({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["nextActions", projectId],
    queryFn: () => getNextActions({ data: { projectId } }),
  });

  if (query.isPending) {
    return (
      <section aria-label="Next actions" aria-busy>
        <div className="skeleton h-40" />
      </section>
    );
  }
  if (query.isError) {
    return (
      <section aria-label="Next actions">
        <div className="alert alert-error">
          {getStandardErrorMessage(query.error)}
        </div>
      </section>
    );
  }

  const snapshot = query.data;
  const allEmpty =
    snapshot.counts.critical === 0 &&
    snapshot.counts.recent === 0 &&
    snapshot.counts.completed === 0 &&
    snapshot.counts.reopened === 0;

  return (
    <section aria-label="Next actions" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Next actions</h2>
        <Link
          to="/p/$projectId/opportunities"
          params={{ projectId }}
          className="link link-hover text-sm"
        >
          All opportunities
        </Link>
      </div>
      {allEmpty ? (
        <p className="text-sm text-base-content/70">
          No opportunities recorded yet. They appear here after an intelligence
          scan.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ViewBlock
            title="Critical"
            count={snapshot.counts.critical}
            rows={snapshot.critical}
            projectId={projectId}
          />
          <ViewBlock
            title="Recent"
            count={snapshot.counts.recent}
            rows={snapshot.recent}
            projectId={projectId}
          />
          <ViewBlock
            title="Completed"
            count={snapshot.counts.completed}
            rows={snapshot.completed}
            projectId={projectId}
          />
          <ViewBlock
            title="Reopened"
            count={snapshot.counts.reopened}
            rows={snapshot.reopened}
            projectId={projectId}
          />
        </div>
      )}
    </section>
  );
}
