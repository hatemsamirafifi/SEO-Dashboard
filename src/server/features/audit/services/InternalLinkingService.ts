import { AppError } from "@/server/lib/errors";
import {
  buildLinkingFindings,
  type InboundStatsMap,
} from "@/server/lib/audit/linking/analyze";
import { buildInternalLinkingReport } from "@/server/lib/audit/linking/report";
import type {
  InboundEdge,
  InternalLinkingReport,
  LinkingFinding,
} from "@/server/lib/audit/linking/types";
import { AuditRepository } from "../repositories/AuditRepository";
import {
  getBrokenLinkEdges,
  getInboundEdgesForTargets,
  getInboundStats,
  getLinkingPages,
  getNonIndexableTargetEdges,
} from "../repositories/linkingQueries";

const PAGE_LEVEL_TYPES = new Set([
  "orphan-page",
  "underlinked-page",
  "deep-page",
  "anchor-text-diversity",
]);

function pageLevelTargetUrls(findings: LinkingFinding[]): string[] {
  return findings
    .filter((finding) => PAGE_LEVEL_TYPES.has(finding.issueType))
    .map((finding) => finding.pageUrl);
}

async function getReport(input: {
  auditId: string;
  projectId: string;
}): Promise<InternalLinkingReport> {
  const audit = await AuditRepository.getAuditForProject(
    input.auditId,
    input.projectId,
  );
  if (!audit) throw new AppError("NOT_FOUND");

  const [pages, stats, brokenEdges, nonIndexableEdges] = await Promise.all([
    getLinkingPages(audit.id),
    getInboundStats(audit.id),
    getBrokenLinkEdges(audit.id),
    getNonIndexableTargetEdges(audit.id),
  ]);
  const statsMap: InboundStatsMap = new Map(
    stats.map((stat) => [stat.targetUrl, stat]),
  );

  const findings = buildLinkingFindings({
    pages,
    stats: statsMap,
    brokenEdges,
    nonIndexableEdges,
    startUrl: audit.startUrl,
    crawlCompleted: audit.status === "completed",
  });
  const inboundEdges: InboundEdge[] = await getInboundEdgesForTargets(
    audit.id,
    pageLevelTargetUrls(findings),
  );

  return buildInternalLinkingReport({
    auditId: audit.id,
    auditStatus: audit.status,
    pages,
    stats: statsMap,
    findings,
    inboundEdges,
  });
}

export const InternalLinkingService = { getReport };
