import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cancelRankCheckRun } from "@/serverFunctions/rank-tracking";

export function useRankRunCancel(
  projectId: string,
  configId: string,
  runId?: string,
) {
  const queryClient = useQueryClient();
  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancelRun = async () => {
    if (!runId) return;
    setIsCancelling(true);
    try {
      await cancelRankCheckRun({
        data: { projectId, configId, runId },
      });
      toast.info("Rank check cancelled");
      for (const key of [
        ["rankTrackingLatestRun"],
        ["rankTrackingResults"],
        ["rankPositionMatrix"],
      ]) {
        void queryClient.invalidateQueries({
          queryKey: [...key, projectId, configId],
        });
      }
    } catch {
      toast.error("Failed to cancel rank check");
    } finally {
      setIsCancelling(false);
    }
  };

  return { isCancelling, handleCancelRun };
}
