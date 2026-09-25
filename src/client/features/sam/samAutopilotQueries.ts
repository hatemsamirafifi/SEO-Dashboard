import { queryOptions } from "@tanstack/react-query";
import { queryClient } from "@/client/tanstack-db";
import {
  getAutopilotRun,
  listAutopilotRuns,
} from "@/serverFunctions/autopilot";

export const autopilotRunsQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["autopilotRuns", projectId],
    queryFn: () => listAutopilotRuns({ data: { projectId } }),
  });

export function invalidateAutopilotRuns(projectId: string) {
  void queryClient.invalidateQueries({
    queryKey: ["autopilotRuns", projectId],
  });
}

export const autopilotRunQueryOptions = (
  projectId: string,
  runId: string | null,
  pollWhileActive: boolean,
) =>
  queryOptions({
    queryKey: ["autopilotRun", projectId, runId],
    queryFn: () =>
      runId
        ? getAutopilotRun({ data: { projectId, runId } })
        : Promise.resolve(null),
    // Live step checklist: poll the durable run while it is pending/running.
    refetchInterval: pollWhileActive && runId ? 3000 : false,
  });

export function invalidateAutopilotRun(projectId: string, runId: string) {
  void queryClient.invalidateQueries({
    queryKey: ["autopilotRun", projectId, runId],
  });
}
