import { type SeoVerificationOutcome } from "@/shared/samSeoAnalyst";
import { type SeoActionRepository } from "./SeoActionRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";

export interface VerificationCheckResult {
  outcome: SeoVerificationOutcome;
  notes: string;
  currentValue: string | null;
  observationDate: string | null;
}

export type ActionItem = NonNullable<
  Awaited<ReturnType<typeof SeoActionRepository.getItemById>>
>;
export type EvidenceRow = Awaited<
  ReturnType<typeof SeoActionRepository.getEvidenceForItem>
>[number];

export function parseBaselinePosition(
  baselineValue: string | null,
): number | null {
  if (!baselineValue) return null;
  const posMatch = /(?:position|pos)\s*[:#]?\s*(\d+(?:\.\d+)?)/i.exec(
    baselineValue,
  );
  if (posMatch) return Number(posMatch[1]);
  const exactNum = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(baselineValue);
  return exactNum ? Number(exactNum[1]) : null;
}

export function evaluatePositionOutcome(
  currentPos: number,
  baselinePos: number | null,
): { outcome: SeoVerificationOutcome; notes: string } {
  if (baselinePos === null) {
    return {
      outcome: "insufficient_data",
      notes: `Found latest position (${currentPos}), but initial baseline value was unparseable.`,
    };
  }
  if (currentPos < baselinePos) {
    return {
      outcome: "implemented_improved",
      notes: `Ranking improved from position ${baselinePos} to ${currentPos} on latest comparable check.`,
    };
  }
  if (currentPos === baselinePos) {
    return {
      outcome: "implemented_unchanged",
      notes: `Ranking remains unchanged at position ${currentPos}.`,
    };
  }
  return {
    outcome: "implemented_declined",
    notes: `Ranking moved lower from position ${baselinePos} to ${currentPos}.`,
  };
}

function isObservationAfterReference(
  observationDate: string | null | undefined,
  baselineDate: string | null | undefined,
  completedAt: string | null | undefined,
): { valid: boolean; reason?: string } {
  if (!observationDate) {
    return { valid: false, reason: "Latest observation timestamp is missing." };
  }
  const obsDay = observationDate.slice(0, 10);
  if (completedAt && obsDay < completedAt.slice(0, 10)) {
    return {
      valid: false,
      reason: `Latest observation (${obsDay}) predates task completion (${completedAt.slice(0, 10)}).`,
    };
  }
  if (baselineDate && observationDate <= baselineDate) {
    return {
      valid: false,
      reason: `Latest observation (${obsDay}) is not newer than baseline (${baselineDate.slice(0, 10)}).`,
    };
  }
  return { valid: true };
}

export async function verifyViaRankTracker(
  item: ActionItem,
  projectId: string,
): Promise<VerificationCheckResult> {
  if (!item.targetKeyword) {
    return {
      outcome: "insufficient_data",
      notes: "No target keyword specified for rank tracking verification.",
      currentValue: null,
      observationDate: null,
    };
  }

  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) {
    return {
      outcome: "insufficient_data",
      notes: "No active rank tracking configuration found for this project.",
      currentValue: null,
      observationDate: null,
    };
  }

  const results = await getLatestResults(configs[0].id, projectId, "previous");
  const lastCheckedAt = results.run?.lastCheckedAt ?? null;
  const freshness = isObservationAfterReference(
    lastCheckedAt,
    item.baselineObservationDate,
    item.completedAt,
  );
  if (!freshness.valid) {
    return {
      outcome: "insufficient_data",
      notes: `${freshness.reason} Awaiting a newer rank tracking observation.`,
      currentValue: null,
      observationDate: lastCheckedAt,
    };
  }

  const matchedRow = results.rows.find(
    (r) =>
      r.keyword.trim().toLowerCase() === item.targetKeyword!.trim().toLowerCase(),
  );
  const devResult = matchedRow
    ? matchedRow.desktop?.position != null
      ? matchedRow.desktop
      : matchedRow.mobile
    : null;

  if (!devResult || devResult.position == null) {
    return {
      outcome: "insufficient_data",
      notes: `No current rank tracking observation found for keyword "${item.targetKeyword}".`,
      currentValue: null,
      observationDate: lastCheckedAt,
    };
  }

  const baselinePos = parseBaselinePosition(item.baselineValue);
  const evalRes = evaluatePositionOutcome(devResult.position, baselinePos);
  return {
    outcome: evalRes.outcome,
    notes: evalRes.notes,
    currentValue: `Position ${devResult.position}`,
    observationDate: lastCheckedAt,
  };
}

export async function verifyViaSearchConsole(
  item: ActionItem,
  projectId: string,
): Promise<VerificationCheckResult> {
  if (!item.targetKeyword) {
    return {
      outcome: "insufficient_data",
      notes: "No target keyword specified for Search Console verification.",
      currentValue: null,
      observationDate: null,
    };
  }

  const coverage =
    await GscSearchPerformanceRepository.getStoredCoverageRange(projectId);
  const baselineDay = item.baselineObservationDate?.slice(0, 10) ?? null;

  if (!coverage || !baselineDay || coverage.endDate <= baselineDay) {
    return {
      outcome: "insufficient_data",
      notes:
        "No newer Search Console coverage period available since baseline observation.",
      currentValue: null,
      observationDate: coverage?.endDate ?? null,
    };
  }

  if (item.completedAt && coverage.endDate < item.completedAt.slice(0, 10)) {
    return {
      outcome: "insufficient_data",
      notes: `Latest Search Console coverage (${coverage.endDate}) predates task completion (${item.completedAt.slice(0, 10)}).`,
      currentValue: null,
      observationDate: coverage.endDate,
    };
  }

  const rowsRes = await GscSearchPerformanceRepository.getTableRows({
    projectId,
    dimension: "query",
    startDate: baselineDay,
    endDate: coverage.endDate,
    page: 1,
    pageSize: 50,
  });
  const queryRow = rowsRes.rows.find(
    (r) => r.key.trim().toLowerCase() === item.targetKeyword!.trim().toLowerCase(),
  );

  if (!queryRow) {
    return {
      outcome: "insufficient_data",
      notes: `Query "${item.targetKeyword}" not observed in Search Console period ending ${coverage.endDate}.`,
      currentValue: null,
      observationDate: coverage.endDate,
    };
  }

  const baselinePos = parseBaselinePosition(item.baselineValue);
  const currentPos = Number(queryRow.position.toFixed(1));
  const evalRes = evaluatePositionOutcome(currentPos, baselinePos);
  return {
    outcome: evalRes.outcome,
    notes: `${evalRes.notes} (GSC period ending ${coverage.endDate}: ${queryRow.clicks} clicks, ${queryRow.impressions} impressions).`,
    currentValue: `${queryRow.clicks} clicks, ${queryRow.impressions} imp, pos ${currentPos}`,
    observationDate: coverage.endDate,
  };
}

export async function verifyViaSiteAudit(
  item: ActionItem,
  evidenceRows: EvidenceRow[],
  projectId: string,
): Promise<VerificationCheckResult> {
  const latestAudit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!latestAudit || !latestAudit.completedAt) {
    return {
      outcome: "insufficient_data",
      notes: "No completed site audit available to verify technical fix.",
      currentValue: null,
      observationDate: null,
    };
  }

  if (item.completedAt && latestAudit.completedAt < item.completedAt) {
    return {
      outcome: "insufficient_data",
      notes: "No site audit has been executed since the task was marked completed.",
      currentValue: null,
      observationDate: latestAudit.completedAt,
    };
  }

  const issues = await AuditRepository.getIssuesForAudit(latestAudit.id, {});
  const relatedEvidence = evidenceRows.find(
    (ev) => ev.source === "get_audit_status",
  );
  const targetIssueType = relatedEvidence?.metricValue;

  const stillPresent = issues.some(
    (iss) =>
      iss.issueType === targetIssueType ||
      iss.issueType === item.validationMetric,
  );

  if (!stillPresent) {
    return {
      outcome: "implemented_improved",
      notes: `Technical defect "${targetIssueType ?? item.title}" was not detected in latest site audit.`,
      currentValue: "Resolved (0 issues)",
      observationDate: latestAudit.completedAt,
    };
  }

  return {
    outcome: "implemented_unchanged",
    notes: `Technical issue was still detected during site audit on ${latestAudit.completedAt}.`,
    currentValue: "Issue still detected",
    observationDate: latestAudit.completedAt,
  };
}
