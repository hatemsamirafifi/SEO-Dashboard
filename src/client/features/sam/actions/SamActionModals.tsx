import { BidiText } from "@/client/components/chat/bidiText";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  seoActionEventsQueryOptions,
  seoActionEvidenceQueryOptions,
} from "./samActionQueries";
import type { getSeoActionPlan } from "@/serverFunctions/seoActions";

export type ActionItemRow = NonNullable<
  Awaited<ReturnType<typeof getSeoActionPlan>>
>["items"][number];

export function NoteModal({
  item,
  noteText,
  isPending,
  onChangeNote,
  onClose,
  onSave,
}: {
  item: ActionItemRow;
  noteText: string;
  isPending: boolean;
  onChangeNote: (text: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label="Add Implementation Note"
        className="w-full max-w-md rounded-xl bg-base-100 p-5 shadow-xl space-y-4"
      >
        <h3 className="text-base font-bold">
          <bdi dir="ltr">Add Note:</bdi>{" "}
          <bdi>
            <BidiText text={item.title} />
          </bdi>
        </h3>
        <textarea
          dir="auto"
          className="textarea textarea-bordered w-full h-24 text-start text-sm"
          placeholder="e.g. Updated meta description tag and published changes..."
          value={noteText}
          onChange={(e) => onChangeNote(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!noteText.trim() || isPending}
            onClick={onSave}
            className="btn btn-primary btn-sm"
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Save Note"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function HistoryModal({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ActionItemRow;
  onClose: () => void;
}) {
  const eventsQuery = useQuery(seoActionEventsQueryOptions(projectId, item.id));
  const events = eventsQuery.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label="Task Audit History"
        className="w-full max-w-lg rounded-xl bg-base-100 p-5 shadow-xl space-y-4"
      >
        <div className="flex items-center justify-between border-b border-base-200 pb-3">
          <h3 className="text-base font-bold">
            <bdi dir="ltr">Task History:</bdi>{" "}
            <bdi>
              <BidiText text={item.title} />
            </bdi>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-xs btn-square"
          >
            ✕
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto space-y-3 pe-1">
          {eventsQuery.isLoading ? (
            <div className="flex justify-center p-4">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : events.length === 0 ? (
            <p className="text-xs text-base-content/50">
              No history events on file.
            </p>
          ) : (
            events.map((evt) => (
              <div
                key={evt.id}
                className="rounded-lg border border-base-200 bg-base-200/30 p-2.5 text-xs space-y-1"
              >
                <div className="flex items-center justify-between text-base-content/60">
                  <span className="font-semibold text-base-content/80">
                    {evt.previousStatus
                      ? `${evt.previousStatus} → ${evt.newStatus}`
                      : `Status: ${evt.newStatus}`}
                  </span>
                  <span>{new Date(evt.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-[11px] text-base-content/50">
                  Actor: {evt.actor}
                </div>
                {evt.notes ? (
                  <p dir="auto" className="wrap-anywhere text-base-content/80">
                    <BidiText text={evt.notes} />
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end pt-2 border-t border-base-200">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function EvidenceModal({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ActionItemRow;
  onClose: () => void;
}) {
  const evidenceQuery = useQuery(
    seoActionEvidenceQueryOptions(projectId, item.id),
  );
  const rows = evidenceQuery.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label="Action Item Evidence"
        className="w-full max-w-lg rounded-xl bg-base-100 p-5 shadow-xl space-y-4"
      >
        <div className="flex items-center justify-between border-b border-base-200 pb-3">
          <h3 className="text-base font-bold">
            <bdi dir="ltr">Evidence:</bdi>{" "}
            <bdi>
              <BidiText text={item.title} />
            </bdi>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-xs btn-square"
          >
            ✕
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto space-y-3 pe-1">
          {evidenceQuery.isLoading ? (
            <div className="flex justify-center p-4">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs text-base-content/50">
              No measured evidence snapshots recorded for this task.
            </p>
          ) : (
            rows.map((ev) => (
              <div
                key={ev.id}
                className="rounded-lg border border-base-200 bg-base-200/30 p-3 text-xs space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="badge badge-outline badge-xs font-mono">
                      {ev.source}
                    </span>
                    <span className="badge badge-ghost badge-xs">
                      provider: {ev.provider}
                    </span>
                  </div>
                  {ev.observationDate ? (
                    <span className="text-base-content/60">
                      Observed: {ev.observationDate}
                    </span>
                  ) : null}
                </div>
                <div className="font-medium text-base-content/90">
                  {ev.metricName}:{" "}
                  <span className="font-mono">{ev.metricValue}</span>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] text-base-content/60">
                  {ev.targetDevice ? (
                    <span>Device: {ev.targetDevice}</span>
                  ) : null}
                  {ev.targetCountry ? (
                    <span>Country: {ev.targetCountry}</span>
                  ) : null}
                  {ev.targetUrl ? (
                    <span className="truncate max-w-xs">
                      URL: <bdi dir="ltr">{ev.targetUrl}</bdi>
                    </span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end pt-2 border-t border-base-200">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
