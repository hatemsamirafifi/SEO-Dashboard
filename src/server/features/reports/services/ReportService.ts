import { waitUntil } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { ScanLedgerRepository } from "@/server/features/intelligence/repositories/ScanLedgerRepository";
import { SharingRepository } from "../repositories/SharingRepository";
import { resolveBrandingSnapshot } from "./BrandingService";
import {
  hashSourceState,
  SourceTokens,
} from "@/server/features/intelligence/services/SourceTokens";
import { INSIGHT_STALE_AFTER_MS } from "@/server/features/intelligence/services/InsightService";
import {
  reportPayloadSchema,
  sectionsForReportType,
  type ConsistencyStatus,
  type ReportPayload,
  type ReportProvenance,
  type ReportType,
} from "@/shared/reports";
import {
  ReportRepository,
  type ReportRow,
} from "../repositories/ReportRepository";
import {
  collectInsights,
  collectOpportunities,
  collectOverviewParts,
  collectSearchVisibility,
  collectTrafficAndConversions,
} from "./reportSections";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validatePeriod(period: { from: string; to: string }): void {
  if (
    !ISO_DATE.test(period.from) ||
    !ISO_DATE.test(period.to) ||
    period.from > period.to
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Report period must be from≤to ISO dates",
    );
  }
}

type CollectedSections = Pick<
  ReportPayload,
  | "searchVisibility"
  | "traffic"
  | "conversions"
  | "rankings"
  | "technical"
  | "backlinks"
  | "opportunities"
  | "insights"
>;

async function collectAttempt(input: {
  projectId: string;
  organizationId: string;
  domain: string | null;
  type: ReportType;
  from: string;
  to: string;
}): Promise<CollectedSections> {
  const sections = sectionsForReportType(input.type);
  const needs = (key: (typeof sections)[number]): boolean =>
    sections.includes(key);
  const [
    searchVisibility,
    trafficParts,
    overviewParts,
    opportunities,
    insights,
  ] = await Promise.all([
    needs("search_visibility")
      ? collectSearchVisibility(input.projectId, input.from, input.to)
      : null,
    needs("traffic") || needs("conversions")
      ? collectTrafficAndConversions(
          input.projectId,
          input.organizationId,
          input.from,
          input.to,
        )
      : null,
    needs("rankings") || needs("technical") || needs("backlinks")
      ? collectOverviewParts(input.projectId, input.domain)
      : null,
    needs("opportunities")
      ? collectOpportunities(input.projectId)
      : Promise.resolve([]),
    needs("insights") ? collectInsights(input.projectId) : Promise.resolve([]),
  ]);
  return {
    searchVisibility: searchVisibility ?? {
      status: { available: false, reason: "not_selected" },
      totals: null,
    },
    traffic: trafficParts?.traffic ?? {
      status: { available: false, reason: "not_selected" },
      totals: null,
    },
    conversions: trafficParts?.conversions ?? {
      status: { available: false, reason: "not_selected" },
      keyEvents: null,
      transactions: null,
    },
    rankings: overviewParts?.rankings ?? {
      status: { available: false, reason: "not_selected" },
      trackedKeywords: null,
      improved: null,
      declined: null,
      top10: null,
      lastCheckedAt: null,
    },
    technical: overviewParts?.technical ?? {
      status: { available: false, reason: "not_selected" },
      auditStatus: null,
      pagesCrawled: null,
      topIssues: null,
    },
    backlinks: overviewParts?.backlinks ?? {
      status: { available: false, reason: "not_selected" },
      referringDomains: null,
      capturedAt: null,
    },
    opportunities,
    insights,
  };
}

async function buildIntelligenceProvenance(
  projectId: string,
): Promise<
  Pick<
    ReportProvenance,
    | "intelligenceRunId"
    | "intelligenceRunHash"
    | "intelligenceManifestHash"
    | "intelligenceCompletedAt"
    | "hasSuccessfulScan"
    | "intelligenceStale"
  >
> {
  const run = await ScanLedgerRepository.getLatestSuccessfulRun(projectId);
  if (!run) {
    return {
      intelligenceRunId: null,
      intelligenceRunHash: null,
      intelligenceManifestHash: null,
      intelligenceCompletedAt: null,
      hasSuccessfulScan: false,
      intelligenceStale: false,
    };
  }
  const stale = run.completedAt
    ? Date.now() - Date.parse(run.completedAt) > INSIGHT_STALE_AFTER_MS
    : true;
  return {
    intelligenceRunId: run.id,
    intelligenceRunHash: run.inputHash,
    intelligenceManifestHash: run.manifestHash,
    intelligenceCompletedAt: run.completedAt,
    hasSuccessfulScan: true,
    intelligenceStale: stale,
  };
}

export async function generateReport(input: {
  projectId: string;
  organizationId: string;
  userId?: string;
  domain: string | null;
  type: ReportType;
  period: { from: string; to: string };
  strict?: boolean;
}): Promise<ReportRow> {
  validatePeriod(input.period);
  const generatedAt = new Date().toISOString();

  // Dual-sided provenance (§12): freeze exact when the source state is
  // identical before/after collection; retry once on drift; then either
  // banner the mix or strict-abort.
  const before = await SourceTokens.assembleDetectionSourceState(
    input.projectId,
  );
  const beforeHash = await hashSourceState(before);
  let collected = await collectAttempt({ ...input, ...input.period });
  let afterHash = await hashSourceState(
    await SourceTokens.assembleDetectionSourceState(input.projectId),
  );
  let consistencyStatus: ConsistencyStatus = "consistent";
  let versions: { before: string | null; after: string | null } = {
    before: beforeHash,
    after: beforeHash,
  };
  if (afterHash !== beforeHash) {
    const retryBeforeHash = afterHash;
    collected = await collectAttempt({ ...input, ...input.period });
    afterHash = await hashSourceState(
      await SourceTokens.assembleDetectionSourceState(input.projectId),
    );
    if (afterHash !== retryBeforeHash) {
      if (input.strict) {
        throw new AppError(
          "CONFLICT",
          "Sources changed during report collection",
        );
      }
      consistencyStatus = "concurrent_mutation";
      versions = { before: retryBeforeHash, after: afterHash };
    } else {
      versions = { before: retryBeforeHash, after: afterHash };
    }
  }

  const intelligence = await buildIntelligenceProvenance(input.projectId);
  const payload: ReportPayload = reportPayloadSchema.parse({
    version: 1,
    reportType: input.type,
    sections: sectionsForReportType(input.type),
    period: input.period,
    generatedAt,
    ...collected,
    provenance: {
      consistencyStatus,
      metricSourceVersions:
        consistencyStatus === "consistent" ? versions.before : null,
      collectionVersionsBefore:
        consistencyStatus === "consistent" ? null : versions.before,
      collectionVersionsAfter:
        consistencyStatus === "consistent" ? null : versions.after,
      ...intelligence,
      generatedAt,
    },
  });

  // Agency+client combination frozen at generation time (Task 13): later
  // branding edits never move existing snapshots.
  const branding = await resolveBrandingSnapshot({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  const row = await ReportRepository.insertRow({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    organizationId: input.organizationId,
    type: input.type,
    periodFrom: input.period.from,
    periodTo: input.period.to,
    payloadSnapshotJson: JSON.stringify(payload),
    consistencyStatus,
    intelligenceRunId: intelligence.intelligenceRunId,
    brandingSnapshotJson: JSON.stringify(branding),
  });
  await SharingRepository.insertEvent({
    id: crypto.randomUUID(),
    reportId: row.id,
    organizationId: input.organizationId,
    type: "created",
    userId: input.userId ?? null,
    metadataJson: null,
  });
  waitUntil(
    captureServerEvent({
      distinctId: input.userId ?? input.organizationId,
      event: "report:generate",
      organizationId: input.organizationId,
      properties: {
        project_id: input.projectId,
        report_id: row.id,
        report_type: input.type,
        consistency_status: consistencyStatus,
      },
    }),
  );
  return row;
}

export function parseReportPayload(row: ReportRow): ReportPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadSnapshotJson);
  } catch {
    throw new AppError("INTERNAL_ERROR", "Stored report payload is corrupt");
  }
  return reportPayloadSchema.parse(parsed);
}

export async function listReports(input: {
  projectId: string;
}): Promise<ReportRow[]> {
  return ReportRepository.listByProject(input.projectId);
}

export async function getReport(input: {
  id: string;
  projectId: string;
}): Promise<{ report: ReportRow; payload: ReportPayload } | null> {
  const report = await ReportRepository.getByIdForProject(
    input.id,
    input.projectId,
  );
  if (!report) return null;
  return { report, payload: parseReportPayload(report) };
}

export async function deleteReport(input: {
  id: string;
  projectId: string;
}): Promise<boolean> {
  return ReportRepository.deleteByIdForProject(input.id, input.projectId);
}

export const ReportService = {
  generateReport,
  listReports,
  getReport,
  deleteReport,
};
