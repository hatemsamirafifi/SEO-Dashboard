import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AUTOPILOT_WORKFLOW_DESCRIPTIONS,
  AUTOPILOT_WORKFLOW_LABELS,
  AUTOPILOT_WORKFLOW_TYPES,
  isAutopilotRunActive,
  isAutopilotRunStatus,
  isAutopilotWorkflowType,
  type AutopilotRunStatus,
  type AutopilotWorkflowType,
} from "@/shared/autopilot";
import {
  cancelAutopilotRun,
  getAutopilotRun,
  listAutopilotRuns,
  resumeAutopilotRun,
  startAutopilotRun,
} from "@/serverFunctions/autopilot";
import {
  attemptNote,
  correlationRows,
  recommendationCards,
  runStatusLabel,
  shouldPollRun,
  type AutopilotAttemptLike,
  type AutopilotRunLike,
  type AutopilotStepLike,
} from "./autopilotEvidence";

type RunRow = {
  id: string;
  workflowType: AutopilotWorkflowType;
  status: AutopilotRunStatus;
};

/**
 * SAM Autopilot tab (final-plan §17): workflow picker → live step checklist
 * via getAutopilotRun polling → summary cards linking opportunities and
 * reports → cancel/resume, with attempt/retry visibility throughout.
 */
export function SamAutopilotTab({ projectId }: { projectId: string }) {
  const [workflowType, setWorkflowType] =
    useState<AutopilotWorkflowType>("growth_plan");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["autopilotRuns", projectId],
    queryFn: () => listAutopilotRuns({ data: { projectId } }),
  });
  const runs: RunRow[] = (runsQuery.data?.runs ?? []).flatMap((run) =>
    isAutopilotWorkflowType(run.workflowType) &&
    isAutopilotRunStatus(run.status)
      ? [{ id: run.id, workflowType: run.workflowType, status: run.status }]
      : [],
  );
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;

  const runQuery = useQuery({
    queryKey: ["autopilotRun", projectId, activeRunId],
    queryFn: () =>
      activeRunId
        ? getAutopilotRun({ data: { projectId, runId: activeRunId } })
        : Promise.resolve(null),
    // Live step checklist: poll the durable run while it is pending/running.
    refetchInterval: (query) =>
      query.state.data &&
      isAutopilotRunStatus(query.state.data.run.status) &&
      shouldPollRun(query.state.data.run.status)
        ? 3000
        : false,
  });
  const view = runQuery.data ?? null;

  const refresh = () => {
    void runsQuery.refetch();
    void runQuery.refetch();
  };

  const startMutation = useMutation({
    mutationFn: () => startAutopilotRun({ data: { projectId, workflowType } }),
    onSuccess: ({ runId }) => {
      setSelectedRunId(runId);
      refresh();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: string) =>
      cancelAutopilotRun({ data: { projectId, runId } }),
    onSuccess: refresh,
  });

  const resumeMutation = useMutation({
    mutationFn: (runId: string) =>
      resumeAutopilotRun({ data: { projectId, runId } }),
    onSuccess: refresh,
  });

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-auto px-4 py-4 md:px-6 md:py-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Autopilot</h2>
        <p className="text-sm text-base-content/60">
          Deterministic SEO plans from engine output. Pick a workflow, watch
          each step land, then open the linked opportunities.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-base-300 p-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Workflow</span>
          <select
            className="select select-bordered select-sm w-full"
            value={workflowType}
            onChange={(event) => {
              const next: unknown = event.target.value;
              if (isAutopilotWorkflowType(next)) setWorkflowType(next);
            }}
          >
            {AUTOPILOT_WORKFLOW_TYPES.map((type) => (
              <option key={type} value={type}>
                {AUTOPILOT_WORKFLOW_LABELS[type]}
              </option>
            ))}
          </select>
          <span className="text-xs text-base-content/60">
            {AUTOPILOT_WORKFLOW_DESCRIPTIONS[workflowType]}
          </span>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Start run
        </button>
      </div>

      {startMutation.isError ? (
        <p className="text-sm text-error">
          Could not start the run. Try again in a moment.
        </p>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recent runs</h3>
        {runsQuery.isLoading ? (
          <Loader2 className="size-5 animate-spin text-base-content/40" />
        ) : runs.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No autopilot runs yet. Start one above to see the step checklist
            fill in here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                    run.id === activeRunId
                      ? "border-primary bg-primary/10"
                      : "border-base-300"
                  }`}
                >
                  <span className="font-medium">
                    {AUTOPILOT_WORKFLOW_LABELS[run.workflowType] ??
                      run.workflowType}
                  </span>
                  <span className="text-xs text-base-content/60">
                    {runStatusLabel(run.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {activeRunId && view ? (
        <RunDetail
          projectId={projectId}
          view={view}
          onCancel={() => cancelMutation.mutate(activeRunId)}
          onResume={() => resumeMutation.mutate(activeRunId)}
          cancelPending={cancelMutation.isPending}
          resumePending={resumeMutation.isPending}
        />
      ) : activeRunId ? (
        <Loader2 className="size-5 animate-spin text-base-content/40" />
      ) : null}
    </div>
  );
}

function RunDetail({
  projectId,
  view,
  onCancel,
  onResume,
  cancelPending,
  resumePending,
}: {
  projectId: string;
  view: {
    run: AutopilotRunLike;
    attempts: AutopilotAttemptLike[];
    steps: AutopilotStepLike[];
  };
  onCancel: () => void;
  onResume: () => void;
  cancelPending: boolean;
  resumePending: boolean;
}) {
  const active =
    isAutopilotRunStatus(view.run.status) &&
    isAutopilotRunActive(view.run.status);
  const cards = recommendationCards(view.steps);
  const correlations = correlationRows(view.steps);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-base-300 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {isAutopilotWorkflowType(view.run.workflowType)
            ? AUTOPILOT_WORKFLOW_LABELS[view.run.workflowType]
            : view.run.workflowType}{" "}
          ·{" "}
          {isAutopilotRunStatus(view.run.status)
            ? runStatusLabel(view.run.status)
            : view.run.status}
        </p>
        <div className="flex gap-2">
          {active ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={cancelPending}
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : view.run.status === "cancelled" ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={resumePending}
              onClick={onResume}
            >
              Resume
            </button>
          ) : null}
        </div>
      </div>

      <ol className="flex flex-col gap-1">
        {view.steps.map((step) => (
          <li
            key={step.seq}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span>
              {step.seq + 1}. {step.name}
              <span className="text-xs text-base-content/50">
                {" "}
                · {step.kind}
              </span>
            </span>
            <span className="text-xs text-base-content/60">{step.status}</span>
          </li>
        ))}
      </ol>

      {view.attempts.length > 1 ||
      view.attempts[0]?.status === "invalidated" ? (
        <ul className="flex flex-col gap-1 text-xs text-base-content/60">
          {view.attempts.map((attempt) => (
            <li key={attempt.id}>{attemptNote(attempt)}</li>
          ))}
        </ul>
      ) : null}

      {correlations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Signal overlap</p>
          <ul className="flex flex-col gap-1 text-sm">
            {correlations.map((row) => (
              <li key={row.entity} className="text-base-content/80">
                {row.entity} — {row.agreement} ({row.signals} signal
                {row.signals === 1 ? "" : "s"})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {cards.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Summary</p>
          {cards.map((card) => (
            <div key={card.key} className="rounded-lg bg-base-200 p-3 text-sm">
              <p className="font-medium">{card.suggestedAction}</p>
              <p className="mt-1 text-base-content/70">
                {card.reasoningSummary}
              </p>
              <p className="mt-1 text-xs text-base-content/60">
                Confidence
                {card.confidenceValue !== null
                  ? ` ${card.confidenceValue}`
                  : ""}
                {card.confidenceWhy ? ` — ${card.confidenceWhy}` : ""}
              </p>
              <p className="mt-1 text-xs text-base-content/50">
                {card.dataSource}
              </p>
            </div>
          ))}
          <Link
            to="/p/$projectId/opportunities"
            params={{ projectId }}
            className="btn btn-outline btn-xs self-start"
          >
            Open opportunities
          </Link>
        </div>
      ) : null}

      {view.run.evidenceHash ? (
        <p className="text-xs text-base-content/40">
          Evidence {view.run.evidenceHash.slice(0, 12)}
        </p>
      ) : null}
    </div>
  );
}
