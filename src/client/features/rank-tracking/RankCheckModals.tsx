import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import type { MissingRankingBucket } from "@/shared/rank-tracking";
import { CheckConfirmModal } from "./CheckConfirmModal";
import { MissingRankingsConfirmModal } from "./MissingRankingsConfirmModal";

export function RankCheckModals({
  pendingCheck,
  config,
  projectId,
  isPending,
  onRunCheck,
  onCancel,
}: {
  pendingCheck: {
    count: number;
    keywordIds?: string[];
    missingRankings?: boolean;
    initialStates?: MissingRankingBucket[];
  } | null;
  config: RankTrackingConfig;
  projectId: string;
  isPending: boolean;
  onRunCheck: (params: {
    keywordIds?: string[];
    missingRankings?: boolean;
    missingRankingStates?: MissingRankingBucket[];
  }) => void;
  onCancel: () => void;
}) {
  if (!pendingCheck) return null;
  if (!pendingCheck.missingRankings) {
    return (
      <CheckConfirmModal
        keywordCount={pendingCheck.count}
        devices={config.devices}
        serpDepth={config.serpDepth}
        isPending={isPending}
        onRunNow={() => onRunCheck({ keywordIds: pendingCheck.keywordIds })}
        onCancel={onCancel}
      />
    );
  }
  return (
    <MissingRankingsConfirmModal
      configId={config.id}
      projectId={projectId}
      keywordIds={pendingCheck.keywordIds}
      devices={config.devices}
      serpDepth={config.serpDepth}
      isPending={isPending}
      initialStates={pendingCheck.initialStates}
      onRunNow={(_count, keywordIds, missingRankingStates) =>
        onRunCheck({
          keywordIds,
          missingRankings: true,
          missingRankingStates,
        })
      }
      onCancel={onCancel}
    />
  );
}
