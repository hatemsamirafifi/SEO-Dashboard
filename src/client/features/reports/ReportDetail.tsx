import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Share2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getReport } from "@/serverFunctions/reports";
import { parseBrandingSnapshot } from "@/shared/reports";
import {
  formatPeriod,
  reportTypeLabel,
} from "@/client/features/reports/reportsCopy";
import {
  BrandedReportHeader,
  ConsistencyBanner,
  ProvenanceBlock,
  ReportBody,
} from "@/client/features/reports/ReportSections";
import { ExportReportButtons } from "@/client/features/reports/ExportReportButtons";
import { ShareReportModal } from "@/client/features/reports/ShareReportModal";

export function ReportDetail({
  projectId,
  reportId,
}: {
  projectId: string;
  reportId: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const detailQuery = useQuery({
    queryKey: ["reports", projectId, reportId],
    queryFn: () => getReport({ data: { projectId, id: reportId } }),
  });

  if (detailQuery.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/60">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading report…
      </div>
    );
  }
  if (detailQuery.isError) {
    return (
      <div className="alert alert-error">
        {getStandardErrorMessage(detailQuery.error, "Failed to load report")}
      </div>
    );
  }

  const { report, payload } = detailQuery.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/p/$projectId/reports"
          params={{ projectId }}
          className="btn btn-ghost btn-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          All reports
        </Link>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="h-4 w-4" />
          Share
        </button>
      </div>

      <BrandedReportHeader
        branding={parseBrandingSnapshot(report.brandingSnapshotJson)}
        defaultTitle={`${reportTypeLabel(report.type)} report`}
        periodLabel={formatPeriod({
          from: report.periodFrom,
          to: report.periodTo,
        })}
      />

      <ConsistencyBanner payload={payload} />
      <ProvenanceBlock payload={payload} />
      <ExportReportButtons projectId={projectId} reportId={reportId} />
      <ReportBody payload={payload} />

      <ShareReportModal
        projectId={projectId}
        reportId={reportId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}
