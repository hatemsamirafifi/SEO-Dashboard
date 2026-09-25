const SOURCE_STYLES: Record<string, string> = {
  gsc: "badge-primary",
  ga4: "badge-secondary",
  rank: "badge-accent",
  audit: "badge-warning",
  backlinks: "badge-info",
};

/** Small source badge shared by insights, opportunities, and summaries. */
export function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={`badge badge-sm ${SOURCE_STYLES[source] ?? "badge-ghost"}`}
    >
      {source.toUpperCase()}
    </span>
  );
}
