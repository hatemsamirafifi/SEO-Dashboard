import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  projects,
  rankTrackingTargets,
  seRankingAccountBindings,
  seRankingEngineBindings,
  seRankingKeywordMappings,
  seRankingProjectBindings,
} from "@/db/schema";

export interface SeRankingSyncProjectStatus {
  projectBindingId: string;
  localProjectId: string;
  projectName: string;
  projectDomain: string | null;
  providerAccountBindingId: string;
  remoteSiteId: number | null;
  status: string;
  lastSuccessfulSync: string | null;
  errorMessage: string | null;
  updatedAt: string;
  engineBindingsCount: number;
  keywordMappingsCount: number;
  activeTargetsCount: number;
  isLatestForProject: boolean;
}

export interface SeRankingOrgSyncStatus {
  accounts: Array<{
    id: string;
    status: string;
    credentialVersion: number;
    lastValidatedAt: string | null;
    updatedAt: string;
  }>;
  projects: SeRankingSyncProjectStatus[];
  needsMigrationCount: number;
  failedSyncCount: number;
}

export async function getSeRankingSyncStatus(params: {
  organizationId: string;
  projectId?: string;
}): Promise<SeRankingOrgSyncStatus> {
  const projectConditions = [
    eq(seRankingProjectBindings.organizationId, params.organizationId),
  ];
  if (params.projectId) {
    projectConditions.push(
      eq(seRankingProjectBindings.localProjectId, params.projectId),
    );
  }

  const [accounts, projectBindings, orgProjects, targets] = await Promise.all([
    db
      .select({
        id: seRankingAccountBindings.id,
        status: seRankingAccountBindings.status,
        credentialVersion: seRankingAccountBindings.credentialVersion,
        lastValidatedAt: seRankingAccountBindings.lastValidatedAt,
        updatedAt: seRankingAccountBindings.updatedAt,
      })
      .from(seRankingAccountBindings)
      .where(eq(seRankingAccountBindings.organizationId, params.organizationId))
      .orderBy(desc(seRankingAccountBindings.updatedAt)),
    db
      .select()
      .from(seRankingProjectBindings)
      .where(and(...projectConditions))
      .orderBy(desc(seRankingProjectBindings.updatedAt)),
    db
      .select({
        id: projects.id,
        name: projects.name,
        domain: projects.domain,
      })
      .from(projects)
      .where(eq(projects.organizationId, params.organizationId)),
    db
      .select({
        localProjectId: rankTrackingTargets.localProjectId,
        enabled: rankTrackingTargets.enabled,
      })
      .from(rankTrackingTargets)
      .where(eq(rankTrackingTargets.organizationId, params.organizationId)),
  ]);

  const projectById = new Map(orgProjects.map((p) => [p.id, p]));
  const activeTargetsByProject = new Map<string, number>();
  for (const target of targets) {
    if (!target.enabled) continue;
    activeTargetsByProject.set(
      target.localProjectId,
      (activeTargetsByProject.get(target.localProjectId) ?? 0) + 1,
    );
  }

  const enriched = await Promise.all(
    projectBindings.map(async (binding) => {
      const [engines, mappings] = await Promise.all([
        db
          .select({ id: seRankingEngineBindings.id })
          .from(seRankingEngineBindings)
          .where(eq(seRankingEngineBindings.projectBindingId, binding.id)),
        db
          .select({ id: seRankingKeywordMappings.id })
          .from(seRankingKeywordMappings)
          .where(eq(seRankingKeywordMappings.projectBindingId, binding.id)),
      ]);
      const proj = projectById.get(binding.localProjectId);
      return {
        projectBindingId: binding.id,
        localProjectId: binding.localProjectId,
        projectName: proj?.name ?? binding.localProjectId,
        projectDomain: proj?.domain ?? null,
        providerAccountBindingId: binding.providerAccountBindingId,
        remoteSiteId: binding.remoteSiteId,
        status: binding.status,
        lastSuccessfulSync: binding.lastSuccessfulSync,
        errorMessage: binding.errorMessage,
        updatedAt: binding.updatedAt,
        engineBindingsCount: engines.length,
        keywordMappingsCount: mappings.length,
        activeTargetsCount:
          activeTargetsByProject.get(binding.localProjectId) ?? 0,
        isLatestForProject: false,
      };
    }),
  );

  const seenLatest = new Set<string>();
  for (const item of enriched) {
    if (!seenLatest.has(item.localProjectId)) {
      seenLatest.add(item.localProjectId);
      item.isLatestForProject = true;
    }
  }

  const latestItems = enriched.filter((p) => p.isLatestForProject);
  const needsMigrationCount = latestItems.filter(
    (p) => p.status === "migration_required",
  ).length;
  const failedSyncCount = latestItems.filter(
    (p) => p.status === "failed" || p.status === "paused",
  ).length;

  return {
    accounts,
    projects: enriched,
    needsMigrationCount,
    failedSyncCount,
  };
}
