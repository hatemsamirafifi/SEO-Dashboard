import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getOpportunity,
  listOpportunities,
  updateOpportunityStatus,
} from "@/serverFunctions/opportunities";
import {
  formatDateTime,
  formatMissInfo,
  priorityBadgeClass,
  priorityLabel,
  statusBadgeClass,
  statusLabel,
  typeLabel,
} from "@/client/features/opportunities/opportunitiesCopy";
import {
  DismissModal,
  EvidenceSection,
  HistorySection,
  ScoreBreakdown,
} from "@/client/features/opportunities/OpportunityDetailSections";

export function OpportunityDetail({
  projectId,
  opportunityId,
}: {
  projectId: string;
  opportunityId: string;
}) {
  const queryClient = useQueryClient();
  const [showDismiss, setShowDismiss] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["opportunity", projectId, opportunityId],
    queryFn: () => getOpportunity({ data: { projectId, id: opportunityId } }),
    placeholderData: keepPreviousData,
  });
  const relatedQuery = useQuery({
    queryKey: ["opportunities", projectId, "related"],
    queryFn: () => listOpportunities({ data: { projectId } }),
    enabled: detailQuery.data !== undefined,
    placeholderData: keepPreviousData,
  });

  const mutation = useMutation({
    mutationFn: (input: {
      status: "open" | "in_progress" | "completed" | "dismissed";
      reason?: string;
    }) =>
      updateOpportunityStatus({
        data: { projectId, id: opportunityId, ...input },
      }),
    onSuccess: () => {
      setShowDismiss(false);
      void queryClient.invalidateQueries({
        queryKey: ["opportunity", projectId, opportunityId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opportunities", projectId],
      });
      toast.success("Opportunity updated.");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to update status"));
    },
  });

  const result = detailQuery.data;
  if (detailQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
        <Loader2 className="size-4 animate-spin" /> Loading opportunity…
      </div>
    );
  }
  if (detailQuery.isError || !result) {
    return (
      <div className="space-y-3">
        <div className="alert alert-error">
          <span className="text-sm">
            {getStandardErrorMessage(
              detailQuery.error,
              "Failed to load the opportunity",
            )}
          </span>
        </div>
        <BackLink projectId={projectId} />
      </div>
    );
  }

  const { opportunity: row, events } = result;
  const missInfo = formatMissInfo({
    consecutiveMisses: row.consecutiveMisses,
    stale: row.stale,
  });
  const related = (relatedQuery.data?.opportunities ?? [])
    .filter(
      (candidate) =>
        candidate.id !== row.id &&
        ((row.keyword !== null && candidate.keyword === row.keyword) ||
          (row.page !== null && candidate.page === row.page)),
    )
    .slice(0, 5);
  const isTerminal = row.status === "completed" || row.status === "dismissed";

  const setStatus = (
    status: "open" | "in_progress" | "completed" | "dismissed",
    reason?: string,
  ) => mutation.mutate({ status, ...(reason ? { reason } : {}) });

  return (
    <div className="space-y-4">
      <BackLink projectId={projectId} />
      <div>
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
          <span className="badge badge-ghost badge-sm">
            Occurrence #{row.occurrenceNumber}
          </span>
        </div>
        <h1 className="mt-2 text-xl font-semibold">{row.title}</h1>
        <p className="mt-1 text-sm text-base-content/70">
          {row.explanationFact}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/60">
          {row.keyword ? <span>Keyword: {row.keyword}</span> : null}
          {row.page ? <span className="truncate">Page: {row.page}</span> : null}
          <span>Last seen {formatDateTime(row.lastDetectedAt)}</span>
          {missInfo ? <span className="text-warning">{missInfo}</span> : null}
          {row.recurrenceOfId ? (
            <span>Recurrence of a closed occurrence</span>
          ) : null}
          {row.supersededById ? (
            <span>Superseded by a newer occurrence</span>
          ) : null}
        </div>
      </div>

      <ScoreBreakdown row={row} />
      <EvidenceSection row={row} />
      <HistorySection events={events} />

      <section aria-label="Recommendation">
        <h2 className="mb-2 font-semibold">Recommendation</h2>
        <div className="rounded-xl border border-base-300 bg-base-100 p-4 text-sm">
          {row.recommendation}
        </div>
      </section>

      {related.length > 0 ? (
        <section aria-label="Related opportunities">
          <h2 className="mb-2 font-semibold">Related</h2>
          <ul className="space-y-2">
            {related.map((candidate) => (
              <li key={candidate.id}>
                <Link
                  to="/p/$projectId/opportunities/$opportunityId"
                  params={{ projectId, opportunityId: candidate.id }}
                  className="block rounded-xl border border-base-300 bg-base-100 px-4 py-2 text-sm hover:border-primary/50"
                >
                  <span className="font-medium">{candidate.title}</span>
                  <span className="ml-2 text-base-content/60">
                    {candidate.status} · occurrence #
                    {candidate.occurrenceNumber}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!isTerminal ? (
        <section
          aria-label="Change status"
          className="flex flex-wrap gap-2 border-t border-base-300 pt-4"
        >
          {row.status === "open" ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={mutation.isPending}
              onClick={() => setStatus("in_progress")}
            >
              Start progress
            </button>
          ) : null}
          {row.status === "in_progress" ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={mutation.isPending}
              onClick={() => setStatus("open")}
            >
              Reopen
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-success btn-sm"
            disabled={mutation.isPending}
            onClick={() => setStatus("completed")}
          >
            Mark complete
          </button>
          <button
            type="button"
            className="btn btn-error btn-sm"
            disabled={mutation.isPending}
            onClick={() => setShowDismiss(true)}
          >
            Dismiss
          </button>
        </section>
      ) : (
        <p className="border-t border-base-300 pt-4 text-sm text-base-content/60">
          This occurrence is {row.status} and read-only. A recurrence opens a
          new occurrence.
          {row.dismissalReason ? ` Reason: ${row.dismissalReason}` : ""}
        </p>
      )}

      {showDismiss ? (
        <DismissModal
          onClose={() => setShowDismiss(false)}
          onConfirm={(reason) => setStatus("dismissed", reason)}
          isPending={mutation.isPending}
        />
      ) : null}
    </div>
  );
}

function BackLink({ projectId }: { projectId: string }) {
  return (
    <Link
      to="/p/$projectId/opportunities"
      params={{ projectId }}
      className="btn btn-ghost btn-sm"
    >
      ← All opportunities
    </Link>
  );
}
