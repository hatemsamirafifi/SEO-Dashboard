import { createServerFn } from "@tanstack/react-start";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  seRankingSelectiveSyncPreviewSchema,
  seRankingSelectiveSyncConfirmSchema,
  seRankingKeywordSyncStatusesInputSchema,
} from "@/types/schemas/rank-tracking";
import {
  confirmSelectiveSeRankingSync,
  getSeRankingKeywordSyncStatuses,
  previewSelectiveSeRankingSync,
} from "@/server/features/rank-tracking/services/seRankingSelectiveSyncService";

export const previewSeRankingSelectiveSync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seRankingSelectiveSyncPreviewSchema)
  .handler(({ data, context }) =>
    previewSelectiveSeRankingSync({
      ...data,
      organizationId: context.organizationId,
      projectId: context.projectId,
    }),
  );

export const confirmSeRankingSelectiveSync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(seRankingSelectiveSyncConfirmSchema)
  .handler(({ data, context }) =>
    confirmSelectiveSeRankingSync({
      ...data,
      organizationId: context.organizationId,
      projectId: context.projectId,
    }),
  );

export const getSeRankingKeywordSyncStatusesFn = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(seRankingKeywordSyncStatusesInputSchema)
  .handler(({ data, context }) =>
    getSeRankingKeywordSyncStatuses({
      configId: data.configId,
      organizationId: context.organizationId,
      projectId: context.projectId,
    }),
  );
