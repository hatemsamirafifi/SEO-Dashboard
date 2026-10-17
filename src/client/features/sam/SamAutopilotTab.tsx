import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AUTOPILOT_WORKFLOW_DESCRIPTIONS,
  AUTOPILOT_WORKFLOW_LABELS,
  AUTOPILOT_WORKFLOW_TYPES,
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
import { runStatusLabel, shouldPollRun } from "./autopilotEvidence";
import { RunDetail } from "./SamAutopilotRunDetail";

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
          {workflowType === "competitor_gap" ? (
            <span className="text-xs font-medium text-warning">
              Notice: Competitor Gap is development-complete and operationally
              locked behind G5. Runs will be refused until G5 is READY.
            </span>
          ) : null}
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
          {startMutation.error instanceof Error
            ? startMutation.error.message
            : "Could not start the run. Try again in a moment."}
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
