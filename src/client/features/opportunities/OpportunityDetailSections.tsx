import { useState } from "react";
import {
  eventLabel,
  factorLabel,
  formatDateTime,
  humanizeKey,
  parseEvidenceJson,
  parseEventReason,
  validateDismissalReason,
} from "@/client/features/opportunities/opportunitiesCopy";
import type { getOpportunity } from "@/serverFunctions/opportunities";

export type DetailRow = Awaited<
  ReturnType<typeof getOpportunity>
>["opportunity"];

export type DetailEvent = Awaited<
  ReturnType<typeof getOpportunity>
>["events"][number];

function ScoreField({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
        {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

export function ScoreBreakdown({ row }: { row: DetailRow }) {
  const breakdown = row.impactBreakdown;
  return (
    <section aria-label="Score breakdown" className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <ScoreField label="Impact" value={row.impactScore} />
        <ScoreField label="Confidence" value={row.confidenceScore} />
        <div className="rounded-xl border border-base-300 bg-base-100 px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
            Priority
          </div>
          <div className="text-2xl font-semibold">{row.priority}</div>
        </div>
      </div>
      {breakdown ? (
        <div className="overflow-hidden rounded-xl border border-base-300">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Impact factor</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Value</th>
                <th className="text-right">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.rows.map((factorRow) => (
                <tr key={factorRow.factor}>
                  <td>{factorLabel(factorRow.factor)}</td>
                  <td className="text-right">{factorRow.weight}</td>
                  <td className="text-right">
                    {factorRow.value === null
                      ? "n/a"
                      : factorRow.value.toFixed(2)}
                  </td>
                  <td className="text-right">
                    {factorRow.value === null
                      ? "n/a"
                      : (factorRow.weight * factorRow.value).toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Renormalized divisor</td>
                <td className="text-right">{breakdown.divisor}</td>
                <td className="text-right">Score</td>
                <td className="text-right font-semibold">
                  {breakdown.score ?? "n/a"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="text-sm text-base-content/60">
          Score inputs are unavailable for this occurrence.
        </p>
      )}
      {row.confidenceInputs ? (
        <div className="rounded-xl border border-base-300 bg-base-100 p-4">
          <h3 className="text-sm font-semibold">Confidence inputs</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-3">
            {Object.entries(row.confidenceInputs).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-base-content/60">{humanizeKey(key)}</dt>
                <dd className="font-medium">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}

export function EvidenceSection({ row }: { row: DetailRow }) {
  const evidence = parseEvidenceJson(row.evidenceJson);
  if (!evidence) {
    return (
      <section aria-label="Evidence">
        <h2 className="mb-2 font-semibold">Evidence</h2>
        <p className="text-sm text-base-content/60">
          Stored evidence is unavailable for this occurrence.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Evidence" className="space-y-3">
      <h2 className="font-semibold">Evidence</h2>
      <div className="overflow-hidden rounded-xl border border-base-300">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(evidence.metrics).map(([key, value]) => (
              <tr key={key}>
                <td>{humanizeKey(key)}</td>
                <td className="text-right font-medium">
                  {typeof value === "number"
                    ? Number.isInteger(value)
                      ? value.toLocaleString("en-US")
                      : value.toFixed(3)
                    : String(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2 text-sm text-base-content/60">
        {evidence.periods ? (
          <span>
            Period: {evidence.periods.from} … {evidence.periods.to}
          </span>
        ) : null}
        <span>Sources: {evidence.sources.join(", ")}</span>
      </div>
      {evidence.thresholdsApplied ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-base-content/70">
            Thresholds applied
          </summary>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
            {Object.entries(evidence.thresholdsApplied).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-base-content/60">{humanizeKey(key)}</dt>
                <dd className="font-medium">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {evidence.sourceRefs &&
      Object.values(evidence.sourceRefs).some((refs) => refs.length > 0) ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-base-content/70">
            Source references
          </summary>
          <dl className="mt-1 space-y-1">
            {Object.entries(evidence.sourceRefs).map(([key, refs]) =>
              Array.isArray(refs) && refs.length > 0 ? (
                <div key={key} className="flex flex-col gap-1">
                  <dt className="text-base-content/60">{humanizeKey(key)}</dt>
                  <dd className="break-all font-mono text-xs">
                    {refs.join(", ")}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </details>
      ) : null}
      {evidence.partialData && evidence.partialData.length > 0 ? (
        <p className="text-sm text-base-content/60">
          Partial data: {evidence.partialData.join("; ")}
        </p>
      ) : null}
    </section>
  );
}

export function HistorySection({ events }: { events: DetailEvent[] }) {
  if (events.length === 0) {
    return (
      <section aria-label="History">
        <h2 className="mb-2 font-semibold">History</h2>
        <p className="text-sm text-base-content/60">No recorded events yet.</p>
      </section>
    );
  }
  return (
    <section aria-label="History">
      <h2 className="mb-2 font-semibold">History</h2>
      <ol className="space-y-2">
        {events.map((event) => {
          const reason = parseEventReason(event.payloadJson);
          return (
            <li
              key={event.id}
              className="flex flex-wrap items-baseline gap-x-3 rounded-xl border border-base-300 bg-base-100 px-4 py-2 text-sm"
            >
              <span className="font-medium">{eventLabel(event.type)}</span>
              <span className="text-base-content/60">
                {formatDateTime(event.createdAt)}
              </span>
              {reason ? (
                <span className="text-base-content/70">— {reason}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function DismissModal({
  onClose,
  onConfirm,
  isPending,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const error = touched ? validateDismissalReason(reason) : null;
  return (
    <div className="modal modal-open" role="dialog" aria-modal="true">
      <div className="modal-box">
        <h3 className="font-semibold">Dismiss opportunity</h3>
        <p className="mt-1 text-sm text-base-content/60">
          A reason is required. The occurrence stays in history; a recurrence
          opens a new occurrence.
        </p>
        <textarea
          aria-label="Dismissal reason"
          className="textarea textarea-bordered mt-3 w-full"
          rows={3}
          placeholder="Why is this no longer relevant?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        {error ? <p className="mt-1 text-sm text-error">{error}</p> : null}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-error"
            disabled={isPending || validateDismissalReason(reason) !== null}
            onClick={() => onConfirm(reason.trim())}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
