import { waitUntil } from "cloudflare:workers";
import {
  canonicalJson,
  stableHash,
  type Finding,
} from "@/shared/intelligence";
import { captureServerEvent } from "@/server/lib/posthog";
import { ArtifactStore } from "../repositories/ArtifactStore";
import {
  InsightRepository,
  type InsightRow,
} from "../repositories/InsightRepository";
import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  groupFindings,
  jaccard,
  METRIC_DRIFT_FLOOR,
  METRIC_DRIFT_RATIO,
  type GroupedInsight,
} from "./insightGroups";

/**
 * Stage-3 insight composer (final-plan §§6/11). Input = the parsed frozen
 * artifact + live active-opportunity rows for linkage (stage_state staged
 * IDs stay the audit record — live lookup is the correct linkage for
 * redetected rows). No source-metric reads. Every write is idempotent, so
 * resume and replay are safe.
 */

export type ComposeStats = {
  created: number;
  updated: number;
  versionBumped: number;
  resolved: number;
  reopened: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function parseMetrics(json: string | null): Record<string, number> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

async function contentHashOf(input: {
  severity: string;
  title: string;
  recommendation: string;
  entityRefs: string[];
  findingKeys: string[];
  opportunityIds: string[];
  metrics: Record<string, number>;
}): Promise<string> {
  return stableHash({
    severity: input.severity,
    title: input.title,
    recommendation: input.recommendation,
    entityRefs: [...input.entityRefs].toSorted(),
    findingKeys: [...input.findingKeys].toSorted(),
    opportunityIds: [...input.opportunityIds].toSorted(),
    metricFingerprint: await stableHash(input.metrics),
  });
}

function evidenceSummaryOf(group: GroupedInsight): string {
  const facts = group.findings.slice(0, 3).map((f) => f.explanationFact);
  const rest = group.findings.length - facts.length;
  return rest > 0 ? `${facts.join(" ")} (+${rest} more)` : facts.join(" ");
}

type MaterialDecision = { material: boolean; reasons: string[] };

/** Semantic material-change policy (§11): severity / top-5 entity Jaccard
 *  / recommendation-class / linkage always material; metric drift ≥25% with
 *  an absolute floor; period rollover never. */
export function isMaterialChange(
  prev: {
    severity: string;
    recommendation: string | null;
    entityRefsJson: string | null;
    findingKeysJson: string | null;
    opportunityIdsJson: string | null;
    metricsJson: string | null;
  },
  next: {
    severity: string;
    recommendation: string;
    entityRefs: string[];
    findingKeys: string[];
    opportunityIds: string[];
    metrics: Record<string, number>;
  },
): MaterialDecision {
  const reasons: string[] = [];
  if (prev.severity !== next.severity) reasons.push("severity");
  if (jaccard(parseStringArray(prev.entityRefsJson), next.entityRefs) < 0.5) {
    reasons.push("entities");
  }
  if ((prev.recommendation ?? "") !== next.recommendation) {
    reasons.push("recommendation-class");
  }
  const linkageBefore = [
    ...parseStringArray(prev.findingKeysJson),
    ...parseStringArray(prev.opportunityIdsJson),
  ].toSorted().join(",");
  const linkageAfter = [...next.findingKeys, ...next.opportunityIds]
    .toSorted()
    .join(",");
  if (linkageBefore !== linkageAfter) reasons.push("linkage");
  const prevMetrics = parseMetrics(prev.metricsJson);
  for (const [entity, current] of Object.entries(next.metrics)) {
    const baseline = prevMetrics[entity];
    if (baseline === undefined || baseline === 0) continue;
    const delta = Math.abs(current - baseline);
    if (delta / Math.abs(baseline) >= METRIC_DRIFT_RATIO && delta >= METRIC_DRIFT_FLOOR) {
      reasons.push("metrics");
      break;
    }
  }
  return { material: reasons.length > 0, reasons };
}

async function linkOpportunities(
  projectId: string,
  findings: Finding[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const finding of findings) {
    const row = await OpportunityRepository.findActiveByKey(
      projectId,
      `${finding.detectorKey}:${finding.entityKey}`,
    );
    if (row) ids.add(row.id);
  }
  return [...ids].toSorted();
}

function detectorKeyOfInsight(insightKey: string): string | null {
  // dashboard:{detectorKey}[:{sha8}] — detector keys never contain colons.
  const segments = insightKey.split(":");
  return segments.length >= 2 ? (segments[1] ?? null) : null;
}

export async function composeRun(input: { runId: string }): Promise<{
  runId: string;
  insightKeys: string[];
  stats: ComposeStats;
}> {
  const run = await ScanLedgerRepository.getRun(input.runId);
  if (!run) throw new Error(`Intelligence run not found: ${input.runId}`);
  if (run.status === "completed" || run.status === "partial") {
    // Idempotent replay: Stage 3 already committed for this run.
    return {
      runId: run.id,
      insightKeys: [],
      stats: { created: 0, updated: 0, versionBumped: 0, resolved: 0, reopened: 0 },
    };
  }
  if (
    run.currentStage !== "composing" ||
    !run.manifestKey ||
    !run.manifestHash
  ) {
    throw new Error(
      `Run ${input.runId} is not ready to compose (stage ${run.currentStage})`,
    );
  }
  const { findings } = await ArtifactStore.loadArtifact(
    run.manifestKey,
    run.manifestHash,
  );
  const outcomes = await ScanLedgerRepository.getDetectorOutcomes(run.id);
  const completedDetectors = new Set(
    outcomes.filter((o) => o.status === "completed").map((o) => o.detectorKey),
  );
  const groups = await groupFindings(findings);
  const now = nowIso();

  const stats: ComposeStats = {
    created: 0,
    updated: 0,
    versionBumped: 0,
    resolved: 0,
    reopened: 0,
  };
  const composedKeys: string[] = [];
  for (const group of groups) {
    const opportunityIds = await linkOpportunities(
      run.projectId,
      group.findings,
    );
    const hash = await contentHashOf({
      severity: group.severity,
      title: group.title,
      recommendation: group.recommendation,
      entityRefs: group.entityRefs,
      findingKeys: group.findingKeys,
      opportunityIds,
      metrics: group.metrics,
    });
    const periods = group.periods;
    const existing = await InsightRepository.findByKey(
      run.projectId,
      group.insightKey,
    );
    composedKeys.push(group.insightKey);
    if (!existing) {
      await InsightRepository.insertRow({
        id: crypto.randomUUID(),
        projectId: run.projectId,
        organizationId: run.organizationId,
        insightKey: group.insightKey,
        composerKey: group.composerKey,
        type: group.detectorKey,
        detectorKey: group.detectorKey,
        severity: group.severity,
        title: group.title,
        explanationFact: group.explanationFact,
        recommendation: group.recommendation,
        evidenceSummary: evidenceSummaryOf(group),
        entityRefsJson: JSON.stringify(group.entityRefs),
        periodsFrom: periods?.from ?? null,
        periodsTo: periods?.to ?? null,
        sourcesJson: JSON.stringify(group.sources),
        findingKeysJson: JSON.stringify(group.findingKeys),
        opportunityIdsJson: JSON.stringify(opportunityIds),
        metricsJson: canonicalJson(group.metrics),
        contentVersion: 1,
        contentHash: hash,
        scanId: run.id,
        detectedAt: now,
        lastSeenAt: now,
      });
      stats.created += 1;
      continue;
    }
    if (existing.resolvedAt) {
      const scansSince = await InsightRepository.countRunsSince(
        run.projectId,
        existing.resolvedAt,
      );
      await InsightRepository.updateById(existing.id, {
        severity: group.severity,
        title: group.title,
        explanationFact: group.explanationFact,
        recommendation: group.recommendation,
        evidenceSummary: evidenceSummaryOf(group),
        entityRefsJson: JSON.stringify(group.entityRefs),
        periodsFrom: periods?.from ?? null,
        periodsTo: periods?.to ?? null,
        sourcesJson: JSON.stringify(group.sources),
        findingKeysJson: JSON.stringify(group.findingKeys),
        opportunityIdsJson: JSON.stringify(opportunityIds),
        metricsJson: canonicalJson(group.metrics),
        contentVersion: existing.contentVersion + 1,
        contentHash: hash,
        scanId: run.id,
        lastSeenAt: now,
        resolvedAt: null,
        resolveReason: `reappeared after ${scansSince} scans clear`,
      });
      stats.reopened += 1;
      continue;
    }
    const decision = isMaterialChange(
      {
        severity: existing.severity,
        recommendation: existing.recommendation,
        entityRefsJson: existing.entityRefsJson,
        findingKeysJson: existing.findingKeysJson,
        opportunityIdsJson: existing.opportunityIdsJson,
        metricsJson: existing.metricsJson,
      },
      {
        severity: group.severity,
        recommendation: group.recommendation,
        entityRefs: group.entityRefs,
        findingKeys: group.findingKeys,
        opportunityIds,
        metrics: group.metrics,
      },
    );
    if (decision.material) {
      await InsightRepository.updateById(existing.id, {
        severity: group.severity,
        title: group.title,
        explanationFact: group.explanationFact,
        recommendation: group.recommendation,
        evidenceSummary: evidenceSummaryOf(group),
        entityRefsJson: JSON.stringify(group.entityRefs),
        periodsFrom: periods?.from ?? null,
        periodsTo: periods?.to ?? null,
        sourcesJson: JSON.stringify(group.sources),
        findingKeysJson: JSON.stringify(group.findingKeys),
        opportunityIdsJson: JSON.stringify(opportunityIds),
        metricsJson: canonicalJson(group.metrics),
        contentVersion: existing.contentVersion + 1,
        contentHash: hash,
        scanId: run.id,
        lastSeenAt: now,
      });
      stats.versionBumped += 1;
    } else {
      await InsightRepository.updateById(existing.id, {
        lastSeenAt: now,
        scanId: run.id,
        periodsFrom: periods?.from ?? null,
        periodsTo: periods?.to ?? null,
        evidenceSummary: evidenceSummaryOf(group),
      });
      stats.updated += 1;
    }
  }

  // Resolve pass: absent keys resolve only after a covering compose — a
  // skipped detector's absence never resolves (coverage gap, not clearing).
  const unresolved =
    await InsightRepository.listUnresolvedByProject(run.projectId);
  const composed = new Set(composedKeys);
  for (const row of unresolved) {
    if (composed.has(row.insightKey)) continue;
    const detectorKey = detectorKeyOfInsight(row.insightKey);
    if (!detectorKey || !completedDetectors.has(detectorKey)) continue;
    await InsightRepository.updateById(row.id, {
      resolvedAt: now,
      resolveReason: `absent in scan ${run.id.slice(0, 8)}`,
    });
    stats.resolved += 1;
  }

  const failedCount = outcomes.filter((o) => o.status === "failed").length;
  await ScanLedgerRepository.transitionStage({
    id: run.id,
    toStage: "composing",
    toStatus: failedCount > 0 ? "partial" : "completed",
  });
  console.log(
    `[intelligence:compose] run=${run.id} ` +
      `created=${stats.created} updated=${stats.updated} ` +
      `bumped=${stats.versionBumped} resolved=${stats.resolved} ` +
      `reopened=${stats.reopened}`,
  );
  waitUntil(
    captureServerEvent({
      distinctId: run.organizationId,
      event: "intelligence:compose",
      organizationId: run.organizationId,
      properties: {
        project_id: run.projectId,
        run_id: run.id,
        ...stats,
      },
    }),
  );
  return { runId: run.id, insightKeys: composedKeys, stats };
}

export const InsightComposer = {
  composeRun,
  isMaterialChange,
};
