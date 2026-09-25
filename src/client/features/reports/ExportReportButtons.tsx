import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileDown, Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { exportReportPdf, getExportStatus } from "@/serverFunctions/reports";
import type { z } from "zod";
import type { exportFormatSchema } from "@/types/schemas/reports";

type ExportFormat = z.infer<typeof exportFormatSchema>;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

function downloadUrl(
  projectId: string,
  reportId: string,
  format: ExportFormat,
): string {
  const params = new URLSearchParams({
    projectId,
    reportId,
    format,
  });
  return `/api/report-export?${params.toString()}`;
}

export function ExportReportButtons({
  projectId,
  reportId,
}: {
  projectId: string;
  reportId: string;
}) {
  const queryClient = useQueryClient();
  const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);
  const [readyFormat, setReadyFormat] = useState<ExportFormat | null>(null);
  const [attempts, setAttempts] = useState(0);

  const exportMutation = useMutation({
    mutationFn: (format: ExportFormat) =>
      exportReportPdf({ data: { projectId, reportId, format } }),
    onSuccess: (result, format) => {
      if (result.status === "ready") {
        setReadyFormat(format);
        setPendingFormat(null);
      } else {
        setPendingFormat(format);
        setReadyFormat(null);
        setAttempts(0);
      }
      void queryClient.invalidateQueries({
        queryKey: ["reports", projectId, reportId],
      });
    },
    onError: (error) => {
      setPendingFormat(null);
      toast.error(getStandardErrorMessage(error, "Failed to start export"));
    },
  });

  useEffect(() => {
    if (!pendingFormat) return;
    if (attempts * POLL_INTERVAL_MS >= POLL_TIMEOUT_MS) {
      setPendingFormat(null);
      toast.error("Export is taking too long — try again shortly.");
      return;
    }
    const timer = setTimeout(() => {
      void getExportStatus({
        data: { projectId, reportId, format: pendingFormat },
      }).then(
        (status) => {
          if (status.status === "ready") {
            setReadyFormat(pendingFormat);
            setPendingFormat(null);
          } else if (status.status === "failed") {
            setPendingFormat(null);
            toast.error("Export failed — try again.");
          } else {
            setAttempts((count) => count + 1);
          }
        },
        () => {
          setPendingFormat(null);
          toast.error("Could not check export status.");
        },
      );
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [pendingFormat, attempts, projectId, reportId]);

  const busy = exportMutation.isPending || pendingFormat !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={busy}
        onClick={() => exportMutation.mutate("pdf")}
      >
        {pendingFormat === "pdf" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileDown className="h-4 w-4" />
        )}
        {pendingFormat === "pdf" ? "Rendering PDF…" : "Export PDF"}
      </button>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={busy}
        onClick={() => exportMutation.mutate("html")}
      >
        {pendingFormat === "html" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Printer className="h-4 w-4" />
        )}
        {pendingFormat === "html" ? "Rendering print view…" : "Print view"}
      </button>
      {readyFormat ? (
        <a
          className="btn btn-primary btn-sm"
          href={downloadUrl(projectId, reportId, readyFormat)}
          download
        >
          <Download className="h-4 w-4" />
          Download {readyFormat === "pdf" ? "PDF" : "print view"}
        </a>
      ) : null}
    </div>
  );
}
