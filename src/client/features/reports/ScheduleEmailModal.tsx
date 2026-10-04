import { useState } from "react";
import {
  REPORT_SCHEDULE_CADENCES,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  type ReportScheduleCadence,
  type ReportType,
} from "@/shared/reports";

export type ScheduleFormValues = {
  reportType: ReportType;
  cadence: ReportScheduleCadence;
  recipients: string;
};

/** Create/edit modal for report schedules (spec 012, US1 — T014).
 *  Controlled inputs only; raw share tokens never appear here — the schedule
 *  links an existing share by pick list (or none). */
export function ScheduleEmailModal({
  open,
  initial,
  saving,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  initial?: Partial<ScheduleFormValues>;
  saving: boolean;
  error: string | null;
  onSave: (values: ScheduleFormValues) => void;
  onClose: () => void;
}) {
  const [reportType, setReportType] = useState<ReportType>(
    initial?.reportType ?? "overview",
  );
  const [cadence, setCadence] = useState<ReportScheduleCadence>(
    initial?.cadence ?? "weekly",
  );
  const [recipients, setRecipients] = useState(initial?.recipients ?? "");

  if (!open) return null;

  return (
    <div
      data-testid="schedule-email-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Schedule report"
    >
      <div className="w-full max-w-md rounded-xl bg-base-100 p-5 shadow-lg">
        <h2 className="text-base font-semibold">Schedule report</h2>
        <p className="mt-1 text-sm text-base-content/70">
          Weekly or monthly email delivery of a frozen report snapshot.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-sm font-medium">Report type</span>
            <select
              aria-label="Report type"
              className="select select-bordered select-sm mt-1 w-full"
              value={reportType}
              onChange={(e) => {
                const next = REPORT_TYPES.find((t) => t === e.target.value);
                if (next) setReportType(next);
              }}
            >
              {REPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {REPORT_TYPE_LABELS[type] ?? type}
                </option>
              ))}
            </select>
          </label>

          <fieldset>
            <legend className="text-sm font-medium">Cadence</legend>
            <div className="mt-1 flex gap-4">
              {REPORT_SCHEDULE_CADENCES.map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-1.5 text-sm"
                >
                  <input
                    type="radio"
                    name="schedule-cadence"
                    aria-label={option === "weekly" ? "Weekly" : "Monthly"}
                    className="radio radio-sm"
                    checked={cadence === option}
                    onChange={() => setCadence(option)}
                  />
                  {option === "weekly" ? "Weekly" : "Monthly"}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-sm font-medium">Recipients</span>
            <input
              type="text"
              aria-label="Recipients"
              className="input input-bordered input-sm mt-1 w-full"
              placeholder="owner@example.com, ops@example.com"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
            />
            <span className="mt-1 block text-xs text-base-content/60">
              Comma-separated email addresses, up to 10.
            </span>
          </label>

          {error ? (
            <div className="alert alert-error py-2 text-sm">{error}</div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={() => onSave({ reportType, cadence, recipients })}
          >
            {saving ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
