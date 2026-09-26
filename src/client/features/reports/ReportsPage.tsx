import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  deleteReport,
  generateReport,
  listReports,
} from "@/serverFunctions/reports";
import type { ReportType } from "@/shared/reports";
import {
  assertReportType,
  consistencyBadgeClass,
  consistencyLabel,
  defaultPeriod,
  formatDateTime,
  formatPeriod,
  REPORT_TYPE_OPTIONS,
  reportTypeLabel,
} from "@/client/features/reports/reportsCopy";

type ListRow = Awaited<ReturnType<typeof listReports>>["reports"][number];

function ReportRowCard({
  row,
  projectId,
  onDelete,
  deleting,
}: {
  row: ListRow;
  projectId: string;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-outline badge-sm">
          {reportTypeLabel(row.type)}
        </span>
        <span className={consistencyBadgeClass(row.consistencyStatus)}>
          {consistencyLabel(row.consistencyStatus)}
        </span>
        <span className="text-sm text-base-content/60">
          {formatPeriod({ from: row.periodFrom, to: row.periodTo })}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to="/p/$projectId/reports/$reportId"
          params={{ projectId, reportId: row.id }}
          className="btn btn-primary btn-sm"
        >
          <FileText className="h-4 w-4" />
          Open snapshot
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={deleting}
          onClick={() => onDelete(row.id)}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
        <span className="text-sm text-base-content/60">
          Generated {formatDateTime(row.createdAt)}
        </span>
      </div>
    </div>
  );
}

function GenerateReportModal({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const period = defaultPeriod();
  const [type, setType] = useState<ReportType>("overview");
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [strict, setStrict] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      generateReport({
        data: { projectId, type, period: { from, to }, strict },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reports", projectId] });
      toast.success("Report generated.");
      onClose();
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to generate report"));
    },
  });

  if (!open) return null;
  const valid = from <= to;
  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h2 className="text-lg font-semibold">Generate report</h2>
        <p className="mt-1 text-sm text-base-content/70">
          Snapshots freeze the current stored data. Later changes create new
          reports — this one never changes.
        </p>
        <label className="form-control mt-4">
          <span className="label-text mb-1">Report type</span>
          <select
            className="select select-bordered w-full"
            value={type}
            onChange={(event) => {
              assertReportType(event.target.value);
              setType(event.target.value);
            }}
          >
            {REPORT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} — {option.description}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="form-control">
            <span className="label-text mb-1">From</span>
            <input
              type="date"
              className="input input-bordered w-full"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1">To</span>
            <input
              type="date"
              className="input input-bordered w-full"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        {!valid ? (
          <p className="mt-2 text-sm text-error">
            The start date must be on or before the end date.
          </p>
        ) : null}
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={strict}
            onChange={(event) => setStrict(event.target.checked)}
          />
          Strict consistency (abort if data changes during collection)
        </label>
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReportsPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ["reports", projectId],
    queryFn: () => listReports({ data: { projectId } }),
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteReport({ data: { projectId, id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reports", projectId] });
      toast.success("Report deleted.");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to delete report"));
    },
  });

  const rows = listQuery.data?.reports ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-sm text-base-content/70">
            Frozen snapshots of metrics, insights, and opportunities.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setModalOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Generate report
        </button>
      </div>

      {listQuery.isPending ? (
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading reports…
        </div>
      ) : null}
      {listQuery.isError ? (
        <div className="alert alert-error">
          {getStandardErrorMessage(listQuery.error, "Failed to load reports")}
        </div>
      ) : null}
      {listQuery.isSuccess && rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-base-300 p-8 text-center">
          <p className="font-medium">No reports yet</p>
          <p className="mt-1 text-sm text-base-content/70">
            Generate your first snapshot to freeze this project&apos;s current
            state.
          </p>
        </div>
      ) : null}
      {rows.map((row) => (
        <ReportRowCard
          key={row.id}
          row={row}
          projectId={projectId}
          deleting={deleteMutation.isPending}
          onDelete={(id) => deleteMutation.mutate(id)}
        />
      ))}

      <GenerateReportModal
        projectId={projectId}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
