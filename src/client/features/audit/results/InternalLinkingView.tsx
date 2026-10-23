import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Link2 } from "lucide-react";
import { getIssueDescriptor } from "@/shared/audit-issues";
import { getInternalLinkingReport } from "@/serverFunctions/audit";

type Report = Awaited<ReturnType<typeof getInternalLinkingReport>>;
type Target = Report["targets"][number];

const SUMMARY_ITEMS: Array<{
  key: keyof Report["summary"];
  label: string;
}> = [
  { key: "internalLinks", label: "Internal links" },
  { key: "orphanCandidates", label: "Orphan candidates" },
  { key: "underlinkedPages", label: "Underlinked" },
  { key: "deepPages", label: "Deep pages" },
  { key: "brokenLinks", label: "Broken links" },
  { key: "redirectIssues", label: "Redirect issues" },
  { key: "nonIndexableTargets", label: "Non-indexable targets" },
  { key: "anchorDiversityIssues", label: "Anchor diversity" },
];

export function InternalLinkingView({
  projectId,
  auditId,
}: {
  projectId: string;
  auditId: string;
}) {
  const query = useQuery({
    queryKey: ["audit-linking", projectId, auditId],
    queryFn: () => getInternalLinkingReport({ data: { projectId, auditId } }),
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="alert alert-error">
        <AlertCircle className="size-5" />
        <span>We could not load the internal linking report.</span>
      </div>
    );
  }

  const report = query.data;
  if (!report) return null;

  return (
    <div className="space-y-4" data-testid="internal-linking-view">
      <CoverageBanner report={report} />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-base-300 bg-base-300/70 md:grid-cols-4">
        {SUMMARY_ITEMS.map((item) => (
          <div key={item.key} className="bg-base-100 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-base-content/50">
              {item.label}
            </p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums">
              {report.summary[item.key]}
            </p>
          </div>
        ))}
      </div>

      {report.targets.length === 0 ? (
        <div className="py-10 text-center text-base-content/60">
          <Link2 className="mx-auto mb-2 size-6 text-base-content/30" />
          <p className="font-medium">No internal linking findings.</p>
          <p className="mt-1 text-sm">
            The crawl did not observe orphan, underlinked, deep, broken, or
            non-indexable link targets.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {report.targets.map((target) => (
            <TargetCard
              key={`${target.issueType}:${target.pageUrl}:${target.targetUrl ?? ""}`}
              target={target}
            />
          ))}
          {report.targetsTruncated && (
            <p className="text-xs text-base-content/50">
              Showing the first {report.targets.length} findings.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CoverageBanner({ report }: { report: Report }) {
  if (report.coverage.status === "complete") {
    return (
      <p className="text-xs text-base-content/50">
        Analyzed {report.coverage.pagesAnalyzed} crawled pages. Absence-based
        findings are supported by a completed crawl.
      </p>
    );
  }

  return (
    <div className="alert alert-warning" data-testid="linking-partial-coverage">
      <AlertCircle className="size-5" />
      <div>
        <p className="font-medium">Partial crawl coverage.</p>
        <p className="text-sm">
          {report.coverage.reason ??
            "The crawl did not complete, so absence-based findings are suppressed."}
        </p>
      </div>
    </div>
  );
}

function TargetCard({ target }: { target: Target }) {
  const descriptor = getIssueDescriptor(target.issueType);
  const severityClass =
    target.severity === "critical"
      ? "border-l-error/60"
      : target.severity === "warning"
        ? "border-l-warning/60"
        : "border-l-base-content/20";

  return (
    <div
      className={`rounded-lg border border-base-300 border-l-2 ${severityClass} bg-base-100 p-3`}
      data-testid="linking-target"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {descriptor?.title ?? target.issueType}
        </span>
        <span className="badge badge-ghost badge-sm">{target.issueType}</span>
      </div>

      {(target.title || target.h1Text) && (
        <p className="mt-1 truncate text-sm text-base-content/80">
          {target.title ?? target.h1Text}
        </p>
      )}

      <a
        className="link link-hover block truncate text-xs text-base-content/50"
        href={target.pageUrl}
        target="_blank"
        rel="noreferrer"
        title={target.pageUrl}
      >
        {target.pageUrl}
      </a>

      {target.targetUrl && target.targetUrl !== target.pageUrl && (
        <p className="mt-0.5 truncate text-xs text-base-content/50">
          Target:{" "}
          <a
            className="link link-hover"
            href={target.targetUrl}
            target="_blank"
            rel="noreferrer"
          >
            {target.targetUrl}
          </a>
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2 text-xs text-base-content/60">
        {target.crawlDepth !== null && <span>Depth {target.crawlDepth}</span>}
        <span>
          {target.inboundLinks} inbound link
          {target.inboundLinks === 1 ? "" : "s"}
        </span>
        <span>
          {target.inboundSources} source
          {target.inboundSources === 1 ? "" : "s"}
        </span>
        {target.inSitemap && <span>In sitemap</span>}
        {target.distinctAnchors > 0 && (
          <span>{target.distinctAnchors} distinct anchor(s)</span>
        )}
      </div>

      <TargetDetails target={target} />

      {target.suggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/50">
            Suggested sources
          </p>
          <ul className="mt-1 space-y-1">
            {target.suggestions.map((suggestion) => (
              <li
                key={suggestion.sourceUrl}
                className="text-sm"
                data-testid="linking-suggestion"
              >
                <a
                  className="link link-hover"
                  href={suggestion.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {suggestion.sourceTitle ?? suggestion.sourceUrl}
                </a>
                <span className="text-xs text-base-content/50">
                  {" "}
                  - shares {suggestion.sharedTerms.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {target.evidence.length > 0 && (
        <div className="mt-2 text-xs text-base-content/50">
          Evidence:{" "}
          {target.evidence
            .map((item) => item.anchor ?? item.sourceUrl)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function TargetDetails({ target }: { target: Target }) {
  if (target.issueType === "link-to-noindex-page") {
    return (
      <p className="mt-2 text-sm text-base-content/70">
        Target is {String(target.details?.reason ?? "non-indexable")}
        {target.details?.canonicalUrl
          ? `; canonical is ${String(target.details.canonicalUrl)}`
          : ""}
        .
      </p>
    );
  }

  if (target.issueType === "broken-internal-link") {
    return (
      <p className="mt-2 text-sm text-base-content/70">
        Target returned status {String(target.details?.targetStatus ?? "error")}
        .
      </p>
    );
  }

  if (
    target.issueType === "redirect-chain" ||
    target.issueType === "redirect-loop"
  ) {
    const hops = target.details?.hops;
    return (
      <p className="mt-2 break-all text-sm text-base-content/70">
        Hops: {Array.isArray(hops) ? hops.join(" -> ") : "see issue details"}.
      </p>
    );
  }

  return null;
}
