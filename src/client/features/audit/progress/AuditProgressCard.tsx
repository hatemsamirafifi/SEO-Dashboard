import { Loader2, StopCircle } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cancelAudit, getCrawlProgress } from "@/serverFunctions/audit";
import {
  getErrorCode,
  getStandardErrorMessage,
} from "@/client/lib/error-messages";
import {
  extractPathname,
  HttpStatusBadge,
} from "@/client/features/audit/shared";

export function AuditProgressCard({
  projectId,
  auditId,
  status,
}: {
  projectId: string;
  auditId: string;
  status: {
    pagesCrawled: number;
    pagesTotal: number;
    lighthouseTotal: number;
    lighthouseCompleted: number;
    lighthouseFailed: number;
    currentPhase: string | null;
  };
}) {
  const crawlProgress =
    status.pagesTotal > 0
      ? Math.round((status.pagesCrawled / status.pagesTotal) * 100)
      : 0;
  const lighthouseDone = status.lighthouseCompleted + status.lighthouseFailed;
  const lighthouseProgress =
    status.lighthouseTotal > 0
      ? Math.round((lighthouseDone / status.lighthouseTotal) * 100)
      : 0;
  const isLighthousePhase = status.currentPhase === "lighthouse";
  const phaseLabel =
    status.currentPhase === "discovery"
      ? "Discovery"
      : status.currentPhase === "crawling"
        ? "Crawling"
        : status.currentPhase === "lighthouse"
          ? "Lighthouse"
          : status.currentPhase === "finalizing"
            ? "Finalizing"
            : (status.currentPhase ?? "Running");
  const progress = isLighthousePhase ? lighthouseProgress : crawlProgress;

  const crawlProgressQuery = useQuery({
    queryKey: ["audit-crawl-progress", projectId, auditId],
    queryFn: () => getCrawlProgress({ data: { projectId, auditId } }),
    refetchInterval: 1500,
  });

  const crawledUrls = crawlProgressQuery.data ?? [];

  return (
    <div className="space-y-3">
      <div className="card bg-base-100 border border-base-300">
        <div className="card-body gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              {isLighthousePhase
                ? "Running Lighthouse checks"
                : "Crawling pages"}
            </h2>
            <div className="flex items-center gap-2">
              <span className="badge badge-ghost badge-sm">{phaseLabel}</span>
              <StopAuditButton projectId={projectId} auditId={auditId} />
            </div>
          </div>

          <progress
            className="progress progress-primary w-full"
            value={progress}
            max={100}
          />

          <div className="flex items-center justify-between text-sm">
            {isLighthousePhase ? (
              <span>
                {lighthouseDone} / {status.lighthouseTotal} checks
                {status.lighthouseFailed > 0
                  ? ` (${status.lighthouseFailed} failed)`
                  : ""}
              </span>
            ) : (
              <span>
                {status.pagesCrawled} / {status.pagesTotal} pages
              </span>
            )}
            <span className="text-base-content/60">{progress}%</span>
          </div>
        </div>
      </div>

      {crawledUrls.length > 0 && (
        <div className="card bg-base-100 border border-base-300">
          <div className="card-body gap-2 p-4">
            <h3 className="text-sm font-medium text-base-content/70">
              Crawled Pages ({crawledUrls.length})
            </h3>
            <p className="text-xs text-base-content/50">
              Updated {new Date(crawledUrls[0].crawledAt).toLocaleTimeString()}
            </p>
            <div className="max-h-[400px] overflow-y-auto -mx-1">
              {crawledUrls.map((entry, i) => (
                <ProgressRow
                  key={`${entry.url}-${entry.crawledAt}`}
                  entry={entry}
                  index={i}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StopAuditButton({
  projectId,
  auditId,
}: {
  projectId: string;
  auditId: string;
}) {
  const cancelMutation = useMutation({
    mutationFn: () => cancelAudit({ data: { projectId, auditId } }),
    onSuccess: () => {
      toast.info("Audit stopping — its workflow will finalize shortly.");
    },
    // CONFLICT/NOT_FOUND can race a self-finalizing workflow; harmless.
    onError: (error) => {
      // CONFLICT/NOT_FOUND can race a self-finalizing workflow; harmless.
      const code = getErrorCode(error);
      if (code !== "CONFLICT" && code !== "NOT_FOUND") {
        toast.error(getStandardErrorMessage(error, "Failed to stop the audit"));
      }
    },
  });

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs gap-1 text-error"
      onClick={() => {
        if (
          window.confirm(
            "Stop this audit? Pages crawled so far are kept, but the report will be partial.",
          )
        ) {
          cancelMutation.mutate();
        }
      }}
      disabled={cancelMutation.isPending}
    >
      {cancelMutation.isPending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <StopCircle className="size-3.5" />
      )}
      Stop
    </button>
  );
}

function ProgressRow({
  entry,
  index,
}: {
  entry: {
    url: string;
    statusCode: number | null;
    title: string | null;
    crawledAt: number;
  };
  index: number;
}) {
  const pathname = extractPathname(entry.url);

  return (
    <div
      className={`flex items-center justify-between gap-3 px-2 py-1.5 rounded text-sm ${
        index === 0
          ? "bg-primary/5 animate-in fade-in slide-in-from-top-1 duration-300"
          : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <HttpStatusBadge code={entry.statusCode} />
        <span className="truncate text-base-content/80" title={entry.url}>
          {pathname}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {entry.title && (
          <span
            className="text-xs text-base-content/40 truncate max-w-[260px] hidden md:block"
            title={entry.title}
          >
            {entry.title}
          </span>
        )}
      </div>
    </div>
  );
}
