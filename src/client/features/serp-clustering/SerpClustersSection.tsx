import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { getSerpClusters } from "@/serverFunctions/rank-tracking";
import {
  serpClusterCoverageBadge,
  serpClusterCoverageLabel,
  serpClusterNewPagesLabel,
  serpClusterSummary,
  SERP_CLUSTER_FORWARD_LOOKING_NOTE,
} from "./serpClusteringCopy";

/**
 * SERP clusters observed for one rank-tracking config and device (spec 019).
 * The section states its coverage honestly and repeats the forward-looking
 * caveat instead of promising a ranking outcome.
 */
export function SerpClustersSection({
  projectId,
  configId,
  device,
}: {
  projectId: string;
  configId: string;
  device: "desktop" | "mobile";
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["serpClusters", projectId, configId, device],
    queryFn: () => getSerpClusters({ data: { projectId, configId, device } }),
  });

  if (isLoading) {
    return (
      <section aria-label="SERP clusters" className="card bg-base-100">
        <div className="card-body">
          <h2 className="card-title text-base">SERP clusters</h2>
          <span className="loading loading-spinner loading-md" />
        </div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section aria-label="SERP clusters" className="card bg-base-100">
        <div className="card-body">
          <h2 className="card-title text-base">SERP clusters</h2>
          <p className="text-sm text-base-content/60">
            The cluster view is unavailable right now.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="SERP clusters"
      className="card bg-base-100 border border-base-300"
      data-testid="serp-clusters-section"
    >
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title text-base">SERP clusters</h2>
          <span
            className={`badge ${serpClusterCoverageBadge(data.coverage.status)}`}
            data-testid="serp-clusters-coverage"
          >
            {serpClusterCoverageLabel(data.coverage.status)}
          </span>
        </div>

        <p className="text-sm text-base-content/70">
          {serpClusterSummary({
            clusterCount: data.clusters.length,
            coveredKeywords: data.coverage.coveredKeywords,
            trackedKeywords: data.coverage.trackedKeywords,
          })}{" "}
          Coverage {data.coverage.percent}% of tracked keywords.
        </p>

        {data.clusters.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No pages were observed together often enough to form a cluster yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.clusters.map((cluster) => (
              <li
                key={cluster.id}
                className="rounded-lg border border-base-300 p-3"
                data-testid="serp-cluster"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link2 className="size-4 text-base-content/40" />
                  <span className="font-medium">
                    {cluster.pages.length} pages on {cluster.keywordCount}{" "}
                    keywords
                  </span>
                  <span className="text-base-content/60">
                    {serpClusterNewPagesLabel(cluster.newPageUrls.length)}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-base-content/60">
                  {cluster.pages.map((page) => (
                    <li key={page.normalizedUrl} className="truncate">
                      {page.normalizedUrl}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-base-content/50">
          {data.caveat ?? SERP_CLUSTER_FORWARD_LOOKING_NOTE}
        </p>
      </div>
    </section>
  );
}
