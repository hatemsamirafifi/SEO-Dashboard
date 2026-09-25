import { Link } from "@tanstack/react-router";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { SourceBadge } from "@/client/components/SourceBadge";
import { StaleBanner } from "@/client/components/StaleBanner";
import {
  dismissInsight,
  getDashboardInsights,
} from "@/serverFunctions/dashboard";
import { listOpportunities } from "@/serverFunctions/opportunities";
import {
  groupInsightsBySection,
  SECTION_META,
  severityBadgeClass,
  severityLabel,
  snoozeWeekFrom,
  type InsightSectionId,
} from "@/client/features/insights/insightsCopy";

type InsightView = Awaited<
  ReturnType<typeof getDashboardInsights>
>["insights"][number];

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function InsightCard({
  insight,
  projectId,
  onDismiss,
  onSnooze,
  acting,
}: {
  insight: InsightView;
  projectId: string;
  onDismiss: (insightKey: string) => void;
  onSnooze: (insightKey: string) => void;
  acting: boolean;
}) {
  const opportunityIds: string[] = Array.isArray(insight.opportunityIds)
    ? insight.opportunityIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  return (
    <article className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={severityBadgeClass(insight.severity)}>
          {severityLabel(insight.severity)}
        </span>
        {insight.updatedSinceDismiss ? (
          <span className="badge badge-info badge-sm">Updated</span>
        ) : null}
        {insight.sources.map((source) => (
          <SourceBadge key={source} source={source} />
        ))}
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={acting}
            title="Snooze for a week"
            onClick={() => onSnooze(insight.insightKey)}
          >
            Snooze
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={acting}
            title="Dismiss this insight"
            aria-label={`Dismiss ${insight.title}`}
            onClick={() => onDismiss(insight.insightKey)}
          >
            Dismiss
          </button>
        </span>
      </div>
      <h3 className="mt-2 font-semibold">{insight.title}</h3>
      <p className="mt-1 text-sm text-base-content/70">
        {insight.explanationFact}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-base-content/60">
        <span>Detected {formatDate(insight.detectedAt)}</span>
        <span>
          {insight.findingKeys.length} finding
          {insight.findingKeys.length === 1 ? "" : "s"}
        </span>
        {opportunityIds.length === 1 ? (
          <Link
            to="/p/$projectId/opportunities/$opportunityId"
            params={{ projectId, opportunityId: opportunityIds[0] ?? "" }}
            className="link link-primary"
          >
            View opportunity
          </Link>
        ) : opportunityIds.length > 1 ? (
          <Link
            to="/p/$projectId/opportunities"
            params={{ projectId }}
            className="link link-primary"
          >
            View {opportunityIds.length} opportunities
          </Link>
        ) : null}
      </div>
    </article>
  );
}

const SECTION_ORDER: InsightSectionId[] = [
  "seo-performance",
  "search-visibility",
  "traffic-engagement",
  "conversions",
  "opportunities-top",
  "technical-health",
  "backlinks",
  "recent-changes",
];

export function InsightSections({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const insightsQuery = useQuery({
    queryKey: ["dashboardInsights", projectId],
    queryFn: () => getDashboardInsights({ data: { projectId } }),
    placeholderData: keepPreviousData,
  });
  const opportunitiesQuery = useQuery({
    queryKey: ["opportunities", projectId, "dashboard-top"],
    queryFn: () => listOpportunities({ data: { projectId } }),
    placeholderData: keepPreviousData,
  });

  const mutatePrefs = useMutation({
    mutationFn: (input: { insightKey: string; snoozedUntil?: string }) =>
      dismissInsight({ data: { projectId, ...input } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["dashboardInsights", projectId],
      });
      toast.success("Preference saved.");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to save preference"));
    },
  });
  const dismiss = (insightKey: string) => mutatePrefs.mutate({ insightKey });
  const snooze = (insightKey: string) =>
    mutatePrefs.mutate({
      insightKey,
      snoozedUntil: snoozeWeekFrom(Date.now()),
    });

  const data = insightsQuery.data;
  if (insightsQuery.isPending) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-base-content/60">
        <Loader2 className="size-4 animate-spin" /> Loading insights…
      </div>
    );
  }
  if (insightsQuery.isError || !data) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(
            insightsQuery.error,
            "Failed to load insights",
          )}
        </span>
      </div>
    );
  }

  const grouped = groupInsightsBySection(data.insights);
  const topOpportunities = (opportunitiesQuery.data?.opportunities ?? [])
    .filter((row) => row.status === "open" || row.status === "in_progress")
    .slice(0, 5);
  const acting = mutatePrefs.isPending;

  return (
    <div className="space-y-4">
      {!data.banner.hasSuccessfulScan ? (
        <div className="rounded-xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/60">
          No intelligence scans yet — insights appear here after the first
          scheduled scan completes.
        </div>
      ) : null}
      {data.banner.stale && data.banner.hasSuccessfulScan ? (
        <StaleBanner
          message={`Intelligence data is stale — last successful scan ${data.banner.lastCompletedAt ?? "unknown"}.`}
        />
      ) : null}
      {data.banner.failed.length > 0 ? (
        <div className="alert alert-error">
          <span className="text-sm">
            Detection failed for{" "}
            {data.banner.failed.map((f) => f.detectorKey).join(", ")}
            {data.banner.failed[0]?.error
              ? `: ${data.banner.failed[0]?.error}`
              : ""}
            . Affected insights may be outdated.
          </span>
        </div>
      ) : null}
      {data.banner.skipped.length > 0 ? (
        <div className="alert alert-warning">
          <span className="text-sm">
            Partial data — skipped:{" "}
            {data.banner.skipped.map((s) => s.detectorKey).join(", ")}. Missing
            coverage is excluded, never zeroed.
          </span>
        </div>
      ) : null}

      {SECTION_ORDER.map((section) => {
        if (section === "opportunities-top") {
          return (
            <section key={section} aria-label={SECTION_META[section].title}>
              <h2 className="mb-2 font-semibold">
                {SECTION_META[section].title}
              </h2>
              {topOpportunities.length === 0 ? (
                <p className="text-sm text-base-content/60">
                  No open opportunities.
                </p>
              ) : (
                <ul className="space-y-2">
                  {topOpportunities.map((opp) => (
                    <li key={opp.id}>
                      <Link
                        to="/p/$projectId/opportunities/$opportunityId"
                        params={{ projectId, opportunityId: opp.id }}
                        className="block rounded-xl border border-base-300 bg-base-100 px-4 py-2 text-sm hover:border-primary/50"
                      >
                        <span className="font-medium">{opp.title}</span>
                        <span className="ml-2 text-base-content/60">
                          {opp.priority} · impact {opp.impactScore}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        }
        if (section === "conversions") {
          return (
            <section key={section} aria-label={SECTION_META[section].title}>
              <h2 className="mb-2 font-semibold">
                {SECTION_META[section].title}
              </h2>
              <p className="text-sm text-base-content/60">
                Conversion insights arrive with a future update.
              </p>
            </section>
          );
        }
        if (section === "recent-changes") {
          const recent = grouped[section].slice(0, 5);
          if (recent.length === 0) return null;
          return (
            <section key={section} aria-label={SECTION_META[section].title}>
              <h2 className="mb-2 font-semibold">
                {SECTION_META[section].title}
              </h2>
              <ul className="space-y-2">
                {recent.map((insight) => (
                  <li
                    key={insight.id}
                    className="rounded-xl border border-base-300 bg-base-100 px-4 py-2 text-sm"
                  >
                    <span className="font-medium">{insight.title}</span>
                    <span className="ml-2 text-base-content/60">
                      {formatDate(insight.detectedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        }
        const rows = grouped[section];
        if (section === "traffic-engagement" && rows.length === 0) {
          if (!data.banner.ga4Connected) {
            return (
              <section key={section} aria-label={SECTION_META[section].title}>
                <h2 className="mb-2 font-semibold">
                  {SECTION_META[section].title}
                </h2>
                <div className="rounded-xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/60">
                  Connect Google Analytics in{" "}
                  <Link to="/settings" className="link link-primary">
                    Settings
                  </Link>{" "}
                  for engagement insights.
                </div>
              </section>
            );
          }
          return null;
        }
        if (rows.length === 0) return null;
        return (
          <section key={section} aria-label={SECTION_META[section].title}>
            <h2 className="mb-2 font-semibold">
              {SECTION_META[section].title}
            </h2>
            <p className="mb-2 text-sm text-base-content/60">
              {SECTION_META[section].description}
            </p>
            <div className="space-y-3">
              {rows.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  projectId={projectId}
                  onDismiss={dismiss}
                  onSnooze={snooze}
                  acting={acting}
                />
              ))}
            </div>
          </section>
        );
      })}
      {data.dismissedCount > 0 ? (
        <p className="text-sm text-base-content/50">
          {data.dismissedCount} dismissed.
        </p>
      ) : null}
    </div>
  );
}
