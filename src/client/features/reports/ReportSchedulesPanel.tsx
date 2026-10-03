import { useState } from "react";
import { REPORT_TYPES, REPORT_TYPE_LABELS } from "@/shared/reports";
import type { ScheduleWithLastRun } from "@/server/features/reports/services/ReportScheduleService";
import {
  ScheduleEmailModal,
  type ScheduleFormValues,
} from "./ScheduleEmailModal";

function cadenceLabel(cadence: string): string {
  return cadence === "weekly"
    ? "Weekly"
    : cadence === "monthly"
      ? "Monthly"
      : cadence;
}

function reportTypeLabel(reportType: string): string {
  for (const type of REPORT_TYPES) {
    if (type === reportType) return REPORT_TYPE_LABELS[type];
  }
  return reportType;
}

function lastRunLabel(lastRun: ScheduleWithLastRun["lastRun"]): string {
  if (!lastRun) return "Not yet run";
  switch (lastRun.state) {
    case "delivered":
      return "Delivered";
    case "partially_delivered":
      return "Partially delivered";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "delivering":
      // US2 resting state: generated, send step pending (US3). Honest and
      // precise — never shown as delivered.
      return "Generated — delivery pending";
    default:
      return "In progress";
  }
}

/** Schedule list + management (spec 012, US1 — T015). Reads stored schedules
 *  only; honest states per the app vocabulary (loading / error / empty with
 *  setup guidance / rows with pause state and last-run chips). */
export function ReportSchedulesPanel({
  projectId,
  schedules,
  loading,
  error,
  onRetry,
  onCreate,
  onPause,
  onResume,
  mutating,
}: {
  projectId: string;
  schedules: ScheduleWithLastRun[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreate: (values: ScheduleFormValues) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  mutating: boolean;
}) {
  void projectId;
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <section
      data-testid="report-schedules-panel"
      aria-label="Scheduled reports"
      className="rounded-xl border border-base-300 bg-base-100 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Scheduled reports</h2>
          <p className="text-sm text-base-content/70">
            Weekly or monthly email delivery of frozen snapshots.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setModalOpen(true)}
        >
          Schedule report
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-base-content/60">Loading schedules…</p>
      ) : null}
      {error && !loading ? (
        <div className="mt-3">
          <p className="text-sm text-error">Something went wrong</p>
          <p className="mt-1 text-xs text-base-content/60">{error}</p>
          <button
            type="button"
            className="btn btn-ghost btn-xs mt-2"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && schedules.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-base-300 p-6 text-center">
          <p className="font-medium">No scheduled reports yet</p>
          <p className="mt-1 text-sm text-base-content/70">
            Schedule a weekly or monthly email and it will appear here with its
            next run.
          </p>
        </div>
      ) : null}

      <ul className="mt-3 space-y-2">
        {schedules.map(({ schedule, lastRun }) => (
          <li
            key={schedule.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-base-200 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {reportTypeLabel(schedule.reportType)} ·{" "}
                {cadenceLabel(schedule.cadence)}
              </p>
              <p className="text-xs text-base-content/60">
                Next run:{" "}
                {schedule.active ? (
                  <span>
                    {new Date(schedule.nextDueAt).toLocaleDateString(
                      undefined,
                      {
                        month: "short",
                        day: "numeric",
                      },
                    )}
                  </span>
                ) : (
                  <span>Paused</span>
                )}{" "}
                · Last run: {lastRunLabel(lastRun)}
              </p>
            </div>
            {schedule.active ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={mutating}
                onClick={() => onPause(schedule.id)}
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={mutating}
                onClick={() => onResume(schedule.id)}
              >
                Resume
              </button>
            )}
          </li>
        ))}
      </ul>

      <ScheduleEmailModal
        open={modalOpen}
        saving={mutating}
        error={null}
        onSave={(values) => {
          onCreate(values);
          setModalOpen(false);
        }}
        onClose={() => setModalOpen(false)}
      />
    </section>
  );
}
