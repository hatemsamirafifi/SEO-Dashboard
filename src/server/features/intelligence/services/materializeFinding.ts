import { SCORE_VERSION } from "@/shared/opportunity-weights";
import {
  canonicalJson,
  confidenceBandOf,
  impactBandOf,
  priorityMatrix,
  stableHash,
  type Finding,
  type OpportunityPriority,
} from "@/shared/intelligence";
import {
  OpportunityRepository,
  type OpportunityRow,
} from "../repositories/OpportunityRepository";
import {
  OPPORTUNITY_TEMPLATES,
  decayConfidence,
  scoreImpact,
  type ImpactFactors,
} from "./opportunityTemplates";

/**
 * Single-finding materialization ops (final-plan §10). Split from
 * OpportunityMaterializer (run orchestration) for the max-lines gate.
 * Race-safe throughout: INSERT … ON CONFLICT DO NOTHING, then SELECT the
 * winner and apply the idempotent in-place update.
 */

export function logicalKeyOf(finding: Finding): string {
  return `${finding.detectorKey}:${finding.entityKey}`;
}

async function evidenceHash(finding: Finding): Promise<string> {
  return stableHash(finding.evidence);
}

async function eventKey(
  occurrenceId: string,
  type: string,
  scanId: string,
  contentHash: string,
): Promise<string> {
  return stableHash(`${occurrenceId}|${type}|${scanId}|${contentHash}`);
}

export async function contentHashOf(input: {
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceHash: string;
  status: string;
}): Promise<string> {
  return stableHash(input);
}

function factorsJson(factors: ImpactFactors): string {
  return canonicalJson({
    trafficPotential: factors.trafficPotential,
    proximity: factors.proximity,
    decline: factors.decline,
    businessIntent: factors.businessIntent,
    conversionSignal: factors.conversionSignal,
  });
}

export async function recordEvent(input: {
  occurrenceId: string;
  type: string;
  scanId: string;
  contentHash: string;
  payload?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await OpportunityRepository.insertEventIgnoreConflict({
    id: crypto.randomUUID(),
    occurrenceId: input.occurrenceId,
    type: input.type,
    eventKey: await eventKey(
      input.occurrenceId,
      input.type,
      input.scanId,
      input.contentHash,
    ),
    scanId: input.scanId,
    payloadJson: input.payload ? canonicalJson(input.payload) : null,
  });
}

export type MaterializeOneResult =
  | { outcome: "created" | "updated" | "recurred" | "superseded"; id: string }
  | { outcome: "skipped"; reason: string };

/**
 * Materializes one frozen finding into the opportunity ledger. Race-safe:
 * INSERT … ON CONFLICT DO NOTHING, then SELECT the winner and apply the
 * idempotent in-place update.
 */
export async function materializeFinding(input: {
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
}): Promise<MaterializeOneResult> {
  const { finding, scanId, projectId, organizationId } = input;
  const template = OPPORTUNITY_TEMPLATES[finding.detectorKey];
  if (!template) {
    return {
      outcome: "skipped",
      reason: `no template: ${finding.detectorKey}`,
    };
  }
  const logicalKey = logicalKeyOf(finding);
  const factors = template.factorsOf(finding);
  const impact = scoreImpact(factors);
  if (impact === null) {
    return { outcome: "skipped", reason: "empty impact factor set" };
  }
  let confidence: number;
  let confidenceInputs: Record<string, string | number | boolean>;
  if (finding.detectorKey === "content_decay") {
    const decayed = decayConfidence(finding);
    if (!decayed) {
      return { outcome: "skipped", reason: "decay volume floor" };
    }
    confidence = decayed.score ?? finding.confidenceScore;
    confidenceInputs = {
      coverage: decayed.inputs.coverage,
      volume: decayed.inputs.volume,
      magnitude: decayed.inputs.magnitude,
      persistence: decayed.inputs.persistence,
      rankSessionMoves: decayed.inputs.rankSessionMoves,
      entityConsistency: decayed.inputs.entityConsistency,
      truncationStatus: decayed.inputs.truncationStatus,
      agreement: decayed.inputs.agreement,
    };
  } else {
    confidence = finding.confidenceScore;
    confidenceInputs = {
      ...finding.evidence.confidenceInputs,
      detectorVersion: finding.detectorVersion,
    };
  }
  const priority = priorityMatrix(
    impactBandOf(impact),
    confidenceBandOf(confidence),
  );
  const evidenceJson = canonicalJson(finding.evidence);
  const hash = await evidenceHash(finding);
  const now = new Date().toISOString();

  const active = await OpportunityRepository.findActiveByKey(
    projectId,
    logicalKey,
  );
  if (active && active.detectorVersion === finding.detectorVersion) {
    return updateInPlace({
      row: active,
      finding,
      scanId,
      template,
      impact,
      confidence,
      priority,
      evidenceJson,
      evidenceHash: hash,
      factors,
      confidenceInputs,
      now,
    });
  }
  if (active) {
    return supersede({
      row: active,
      finding,
      scanId,
      projectId,
      organizationId,
      template,
      impact,
      confidence,
      priority,
      evidenceJson,
      evidenceHash: hash,
      factors,
      confidenceInputs,
      now,
    });
  }
  const latest = await OpportunityRepository.findLatestByKey(
    projectId,
    logicalKey,
  );
  return createOccurrence({
    finding,
    scanId,
    projectId,
    organizationId,
    template,
    impact,
    confidence,
    priority,
    evidenceJson,
    evidenceHash: hash,
    factors,
    confidenceInputs,
    now,
    occurrenceNumber: (latest?.occurrenceNumber ?? 0) + 1,
    recurrenceOfId: latest?.id ?? null,
  });
}

async function updateInPlace(input: {
  row: OpportunityRow;
  finding: Finding;
  scanId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
}): Promise<MaterializeOneResult> {
  const { row, finding, scanId } = input;
  // Decisions come from the PRE-update row so replays are idempotent.
  const bandChanged =
    row.priority !== input.priority ||
    confidenceBandOf(row.confidenceScore) !==
      confidenceBandOf(input.confidence);
  const redetected =
    Date.parse(input.now) - Date.parse(row.lastDetectedAt) >= 86_400_000 ||
    bandChanged;
  const rescored =
    Math.abs(input.impact - row.impactScore) >= 10 || bandChanged;
  const evidenceChanged = input.evidenceJson !== row.evidenceJson;
  const wasStale = row.stale;

  await OpportunityRepository.updateById(row.id, {
    impactScore: input.impact,
    confidenceScore: input.confidence,
    priority: input.priority,
    title: input.template.title(finding),
    explanationFact: finding.explanationFact,
    recommendation: input.template.recommendation(finding),
    evidenceJson: input.evidenceJson,
    keyword: input.template.keywordOf(finding),
    page: input.template.pageOf(finding),
    sourceMetricsJson: canonicalJson(finding.evidence.metrics),
    sourcesJson: JSON.stringify(finding.evidence.sources),
    impactFactorsJson: factorsJson(input.factors),
    confidenceInputsJson: canonicalJson(input.confidenceInputs),
    lastSeenScanId: scanId,
    lastDetectedAt: input.now,
    consecutiveMisses: 0,
    stale: false,
    staleAt: null,
  });

  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: row.status,
  });
  if (redetected) {
    await recordEvent({
      occurrenceId: row.id,
      type: "redetected",
      scanId,
      contentHash: content,
    });
  }
  if (rescored) {
    await recordEvent({
      occurrenceId: row.id,
      type: "rescored",
      scanId,
      contentHash: content,
      payload: { impactScore: input.impact, confidenceScore: input.confidence },
    });
  }
  if (evidenceChanged) {
    await recordEvent({
      occurrenceId: row.id,
      type: "evidence_updated",
      scanId,
      contentHash: content,
    });
  }
  if (wasStale) {
    await recordEvent({
      occurrenceId: row.id,
      type: "stale_cleared",
      scanId,
      contentHash: content,
    });
  }
  return { outcome: "updated", id: row.id };
}

async function createOccurrence(input: {
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
  occurrenceNumber: number;
  recurrenceOfId: string | null;
}): Promise<MaterializeOneResult> {
  const { finding, scanId } = input;
  const id = crypto.randomUUID();
  await OpportunityRepository.insertIgnoreConflict({
    id,
    projectId: input.projectId,
    organizationId: input.organizationId,
    logicalKey: logicalKeyOf(finding),
    occurrenceNumber: input.occurrenceNumber,
    type: input.template.type,
    detectorKey: finding.detectorKey,
    detectorVersion: finding.detectorVersion,
    scoreVersion: SCORE_VERSION,
    status: "open",
    impactScore: input.impact,
    confidenceScore: input.confidence,
    priority: input.priority,
    title: input.template.title(finding),
    explanationFact: finding.explanationFact,
    recommendation: input.template.recommendation(finding),
    evidenceJson: input.evidenceJson,
    keyword: input.template.keywordOf(finding),
    page: input.template.pageOf(finding),
    sourceMetricsJson: canonicalJson(finding.evidence.metrics),
    sourcesJson: JSON.stringify(finding.evidence.sources),
    impactFactorsJson: factorsJson(input.factors),
    confidenceInputsJson: canonicalJson(input.confidenceInputs),
    lastSeenScanId: scanId,
    firstDetectedAt: input.now,
    lastDetectedAt: input.now,
    recurrenceOfId: input.recurrenceOfId,
  });
  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: "open",
  });
  await recordEvent({
    occurrenceId: id,
    type: "detected",
    scanId,
    contentHash: content,
  });
  if (input.recurrenceOfId) {
    await recordEvent({
      occurrenceId: id,
      type: "recurred",
      scanId,
      contentHash: content,
      payload: { recurrenceOfId: input.recurrenceOfId },
    });
    return { outcome: "recurred", id };
  }
  return { outcome: "created", id };
}

async function supersede(input: {
  row: OpportunityRow;
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
}): Promise<MaterializeOneResult> {
  const created = await createOccurrence({
    ...input,
    occurrenceNumber: input.row.occurrenceNumber + 1,
    recurrenceOfId: null,
  });
  if (created.outcome !== "created") return created;
  const newId = created.id;
  await OpportunityRepository.updateById(input.row.id, {
    status: "dismissed",
    dismissedAt: input.now,
    dismissalReason: `detector version ${input.row.detectorVersion} → ${input.finding.detectorVersion}`,
    supersededById: newId,
  });
  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: "dismissed",
  });
  await recordEvent({
    occurrenceId: input.row.id,
    type: "superseded",
    scanId: input.scanId,
    contentHash: content,
    payload: { supersededById: newId },
  });
  return { outcome: "superseded", id: newId };
}
