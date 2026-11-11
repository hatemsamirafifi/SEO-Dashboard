import { AppError } from "@/server/lib/errors";
import {
  isTransientSeRankingError,
  type createSeRankingClient,
} from "@/server/lib/seranking";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";

export interface SyncServiceOps {
  ensureAccountBinding: (params: {
    organizationId: string;
    apiKey: string;
  }) => Promise<{
    binding: { id: string };
    client: ReturnType<typeof createSeRankingClient>;
  }>;
  ensureProject: (params: {
    localProjectId: string;
    organizationId: string;
    domain: string;
    projectName?: string;
    apiKey?: string;
    client?: ReturnType<typeof createSeRankingClient>;
  }) => Promise<{
    projectBinding: { id: string };
    remoteSiteId: number | null;
    migrationDetected: boolean;
  }>;
  ensureSearchEngines: (params: {
    localProjectId: string;
    organizationId: string;
    projectBindingId: string;
    remoteSiteId: number;
    client: ReturnType<typeof createSeRankingClient>;
  }) => Promise<unknown>;
  syncTrackedKeywords: (params: {
    localProjectId: string;
    configId: string;
    projectBindingId: string;
    remoteSiteId: number;
    client: ReturnType<typeof createSeRankingClient>;
  }) => Promise<unknown>;
}

export async function runAccountMigration(
  params: {
    organizationId: string;
    newApiKey: string;
  },
  ops: SyncServiceOps,
) {
  const { binding: newAccountBinding, client: newClient } =
    await ops.ensureAccountBinding({
      organizationId: params.organizationId,
      apiKey: params.newApiKey,
    });

  const oldAccount = await SeRankingBindingRepository.getActiveAccountBinding(
    params.organizationId,
  );

  const projects = await RankTrackingRepository.getProjectsForOrganization(
    params.organizationId,
  );

  const migratedProjects: Array<{
    projectId: string;
    configId: string;
    status: string;
    errorMessage?: string;
  }> = [];
  let anyAccountMigration = false;
  let hadTransientFailure = false;

  for (const project of projects) {
    const configs = await RankTrackingRepository.getConfigsForProject(
      project.id,
    );

    for (const config of configs) {
      let ensuredBindingId: string | null = null;
      try {
        const { projectBinding, remoteSiteId, migrationDetected } =
          await ops.ensureProject({
            localProjectId: project.id,
            organizationId: params.organizationId,
            domain: config.domain,
            projectName: project.name,
            apiKey: params.newApiKey,
            client: newClient,
          });
        ensuredBindingId = projectBinding.id;

        if (migrationDetected) anyAccountMigration = true;

        if (remoteSiteId) {
          await ops.ensureSearchEngines({
            localProjectId: project.id,
            organizationId: params.organizationId,
            projectBindingId: projectBinding.id,
            remoteSiteId,
            client: newClient,
          });

          await ops.syncTrackedKeywords({
            localProjectId: project.id,
            configId: config.id,
            projectBindingId: projectBinding.id,
            remoteSiteId,
            client: newClient,
          });
        }

        const nowIso = new Date().toISOString();
        await SeRankingBindingRepository.updateProjectBinding(
          projectBinding.id,
          {
            status: "connected",
            lastSuccessfulSync: nowIso,
            errorMessage: null,
          },
        );

        migratedProjects.push({
          projectId: project.id,
          configId: config.id,
          status: "connected",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isTransient = isTransientSeRankingError(err);
        if (isTransient) hadTransientFailure = true;

        const isQuota =
          err instanceof AppError &&
          (err.code === "PAYMENT_REQUIRED" || err.code === "FORBIDDEN");
        const nextStatus = isTransient
          ? "pending_retry"
          : isQuota
            ? "paused"
            : "failed";

        if (ensuredBindingId) {
          await SeRankingBindingRepository.updateProjectBinding(
            ensuredBindingId,
            {
              status: isQuota ? "paused" : "failed",
              errorMessage: message,
            },
          );
        }

        migratedProjects.push({
          projectId: project.id,
          configId: config.id,
          status: nextStatus,
          errorMessage: message,
        });
      }
    }
  }

  if (
    oldAccount &&
    oldAccount.id !== newAccountBinding.id &&
    !hadTransientFailure &&
    (anyAccountMigration || projects.length === 0)
  ) {
    await SeRankingBindingRepository.updateAccountBindingStatus(
      oldAccount.id,
      "migration_required",
    );
  }

  return {
    ok: migratedProjects.every((p) => p.status === "connected"),
    temporaryFailure: hadTransientFailure,
    accountBindingId: newAccountBinding.id,
    migratedProjectsCount: migratedProjects.length,
    migratedProjects,
  };
}
