import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { AlertCircle, OctagonX, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getAuditResults, getAuditStatus } from "@/serverFunctions/audit";
import { auditSearchSchema } from "@/types/schemas/audit";
import { LaunchView } from "@/client/features/audit/launch/LaunchView";
import { ResultsView } from "@/client/features/audit/results/ResultsView";
import { AuditProgressCard } from "@/client/features/audit/progress/AuditProgressCard";
import {
  extractHostname,
  formatStartedAt,
  StatusBadge,
  SUPPORT_URL,
} from "@/client/features/audit/shared";

export const Route = createFileRoute<"/_project/p/$projectId/audit/">(
  "/_project/p/$projectId/audit/",
)({
  validateSearch: auditSearchSchema,
  component: SiteAuditPage,
});

function SiteAuditPage() {
  const { projectId } = Route.useParams();
  const { auditId, tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const setSearchParams = useCallback(
    (updates: Record<string, string | undefined>) => {
      void navigate({
        search: (prev) => ({ ...prev, ...updates }),
        replace: true,
      });
    },
    [navigate],
  );

  if (!auditId) {
    return (
      <LaunchView
        projectId={projectId}
        onAuditStarted={(id) => setSearchParams({ auditId: id })}
      />
    );
  }

  return (
    <AuditDetail
      projectId={projectId}
      auditId={auditId}
      tab={tab}
      onBack={() => setSearchParams({ auditId: undefined })}
      onTabChange={(nextTab) => setSearchParams({ tab: nextTab })}
    />
  );
}

function AuditDetail({
  projectId,
  auditId,
  tab,
  onBack,
  onTabChange,
}: {
  projectId: string;
  auditId: string;
  tab: string;
  onBack: () => void;
  onTabChange: (tab: "issues" | "pages" | "performance" | "linking") => void;
}) {
  const statusQuery = useQuery({
    queryKey: ["audit-status", projectId, auditId],
    queryFn: () => getAuditStatus({ data: { projectId, auditId } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "running" ? 3000 : false;
    },
  });

  const readableStatuses = ["completed", "completed_partial", "cancelled"];
  const isComplete = Boolean(
    statusQuery.data && readableStatuses.includes(statusQuery.data.status),
  );
  const isFailed = statusQuery.data?.status === "failed";
  const isRunning = statusQuery.data?.status === "running";
  const isCancelled = statusQuery.data?.status === "cancelled";
  const isPartial = statusQuery.data?.status === "completed_partial";

  const resultsQuery = useQuery({
    queryKey: ["audit-results", projectId, auditId],
    queryFn: () => getAuditResults({ data: { projectId, auditId } }),
    enabled: isComplete,
  });

  if (statusQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="alert alert-error">
            <AlertCircle className="size-5" />
            <span>We could not load this audit. It may have been deleted.</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            &larr; Back to audits
          </button>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  const showSupportCta =
    isFailed || (isComplete && status && status.pagesCrawled <= 1);

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8 overflow-auto">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="space-y-1">
          <button className="btn btn-ghost btn-sm px-0" onClick={onBack}>
            &larr; All audits
          </button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold">
              {status ? extractHostname(status.startUrl) : "Site Audit"}
            </h1>
            {status?.status !== "running" && status && (
              <StatusBadge status={status.status} />
            )}
          </div>
          {status && (
            <p className="text-sm text-base-content/60">
              Site audit &middot; Started {formatStartedAt(status.startedAt)}
            </p>
          )}
        </div>

        {isRunning && status && (
          <AuditProgressCard
            projectId={projectId}
            auditId={auditId}
            status={status}
          />
        )}

        {isCancelled && (
          <div className="alert alert-warning">
            <OctagonX className="size-5" />
            <div className="space-y-1">
              <p className="font-medium">Audit stopped early.</p>
              <p>
                The pages crawled before stopping are listed below. The issue
                report reflects only that partial coverage.
              </p>
            </div>
          </div>
        )}

        {isPartial && status && <PartialAuditBanner urls={status.urls} />}

        {showSupportCta && (
          <div
            className={isFailed ? "alert alert-error" : "alert alert-warning"}
          >
            <AlertCircle className="size-5" />
            <div className="space-y-1">
              <p className="font-medium">
                Site audit couldn't fully crawl this website.
              </p>
              <p>
                This is often caused by anti-bot or firewall settings. Reach out
                at{" "}
                <a
                  className="link link-primary"
                  href={SUPPORT_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  everyapp.dev/support
                </a>{" "}
                and we'll help configure auditing for your site.
              </p>
            </div>
          </div>
        )}

        {isComplete && resultsQuery.data && (
          <ResultsView
            projectId={projectId}
            data={resultsQuery.data}
            tab={tab}
            onTabChange={onTabChange}
          />
        )}
      </div>
    </div>
  );
}

function PartialAuditBanner({
  urls,
}: {
  urls: {
    urlsDiscovered: number;
    urlsFetched: number;
    urlsBlocked: number;
    urlsFailed: number;
    urlsSkipped: number;
    urlsRenderingRequired: number;
  };
}) {
  const parts = [
    urls.urlsBlocked > 0 ? `${urls.urlsBlocked} blocked` : null,
    urls.urlsFailed > 0 ? `${urls.urlsFailed} failed` : null,
    urls.urlsSkipped > 0 ? `${urls.urlsSkipped} skipped` : null,
    urls.urlsRenderingRequired > 0
      ? `${urls.urlsRenderingRequired} need browser checks`
      : null,
  ].filter((part): part is string => part != null);
  const remaining = Math.max(0, urls.urlsDiscovered - urls.urlsFetched);
  if (remaining > 0) {
    parts.push(`${remaining} not crawled`);
  }

  return (
    <div className="alert alert-warning">
      <TriangleAlert className="size-5" />
      <div className="space-y-1">
        <p className="font-medium">Partial crawl — coverage deficit.</p>
        <p>
          This audit finished, but with an incomplete view of the site
          {parts.length > 0 ? `: ${parts.join(", ")}` : ""}. Issue counts below
          understate problems on the pages that were missed.
        </p>
      </div>
    </div>
  );
}
