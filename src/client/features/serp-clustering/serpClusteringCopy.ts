/**
 * Copy for the SERP clusters surface (spec 019).
 *
 * The wording stays forward-looking: the clusters reflect the organic results
 * observed in the stored rank checks, and they are a heuristic, not a
 * prediction.
 */

const SERP_CLUSTER_COVERAGE_LABELS: Record<string, string> = {
  ready: "Ready",
  awaiting_data: "Awaiting SERP data",
  insufficient_data: "Insufficient data",
  stale_data: "Stale data",
};

const SERP_CLUSTER_COVERAGE_BADGES: Record<string, string> = {
  ready: "badge-success",
  awaiting_data: "badge-ghost",
  insufficient_data: "badge-warning",
  stale_data: "badge-warning",
};

export function serpClusterCoverageLabel(status: string): string {
  return SERP_CLUSTER_COVERAGE_LABELS[status] ?? "Unknown";
}

export function serpClusterCoverageBadge(status: string): string {
  return SERP_CLUSTER_COVERAGE_BADGES[status] ?? "badge-ghost";
}

/** The caveat the surface repeats on every cluster view. */
export const SERP_CLUSTER_FORWARD_LOOKING_NOTE =
  "Forward-looking: these clusters reflect the organic results observed in the stored rank checks so far. They are a heuristic, not a prediction of how a page will rank.";

export function serpClusterSummary(input: {
  clusterCount: number;
  coveredKeywords: number;
  trackedKeywords: number;
}): string {
  if (input.clusterCount === 0) {
    return "No clusters observed yet.";
  }
  return `${input.clusterCount} cluster${
    input.clusterCount === 1 ? "" : "s"
  } observed on ${input.coveredKeywords} of ${input.trackedKeywords} tracked keywords.`;
}

export function serpClusterNewPagesLabel(count: number): string {
  if (count === 0) return "No pages outside this project.";
  return `${count} page${count === 1 ? "" : "s"} not on this project.`;
}
