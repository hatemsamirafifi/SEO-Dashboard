import type {
  AnalyticsGeoResult,
  AnalyticsTechnologyResult,
} from "@/server/features/ga4/services/AnalyticsService";
import { SectionError, SectionLoading, formatCount } from "./AnalyticsSections";
import { formatDelta, formatPctChange } from "./analyticsCopy";

function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

export function GeographySection({
  result,
  prevResult,
  pending,
  queryError,
}: {
  result: AnalyticsGeoResult | undefined;
  prevResult?: AnalyticsGeoResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="geography" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;

  if (result.rows.length === 0) {
    return (
      <div className="p-4 text-sm text-base-content/60">
        {result.emptyNote ?? "No country data for this period."}
      </div>
    );
  }

  const prevSessionsByCountry = new Map(
    prevResult?.connected
      ? prevResult.rows.map((row) => [row.country, row.sessions])
      : [],
  );

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <caption className="sr-only">Geography breakdown</caption>
          <thead>
            <tr>
              <th>Country</th>
              <th className="text-right">Sessions</th>
              {prevResult?.connected ? (
                <th className="text-right">Change</th>
              ) : null}
              <th className="text-right">Engaged sessions</th>
              <th className="text-right">Engagement rate</th>
              <th className="text-right">Avg engagement time</th>
              <th className="text-right">Page views</th>
              <th className="text-right">Events</th>
              <th className="text-right">New users</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const prevSessions = prevSessionsByCountry.get(row.country);
              const change =
                prevSessions !== undefined ? row.sessions - prevSessions : null;
              const pctChange =
                prevSessions !== undefined
                  ? prevSessions === 0
                    ? row.sessions === 0
                      ? 0
                      : 100
                    : ((row.sessions - prevSessions) / prevSessions) * 100
                  : null;
              const engagementRate =
                row.sessions > 0 ? row.engagedSessions / row.sessions : 0;
              const avgTime =
                row.sessions > 0
                  ? row.userEngagementDuration / row.sessions
                  : 0;

              return (
                <tr key={row.country}>
                  <td>
                    {row.isOtherRow || row.country === "(other)" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="badge badge-neutral badge-xs">
                          Aggregated
                        </span>
                        <span className="italic text-base-content/70">
                          (other)
                        </span>
                      </span>
                    ) : (
                      row.country
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatCount(row.sessions)}
                  </td>
                  {prevResult?.connected ? (
                    <td
                      className={`text-right tabular-nums ${
                        change! > 0
                          ? "text-success font-medium"
                          : change! < 0
                            ? "text-error font-medium"
                            : "text-base-content/60"
                      }`}
                    >
                      {formatDelta(change!)} ({formatPctChange(pctChange)})
                    </td>
                  ) : null}
                  <td className="text-right tabular-nums">
                    {formatCount(row.engagedSessions)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatRatioAsPercent(engagementRate)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatSeconds(avgTime)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatCount(row.screenPageViews)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatCount(row.eventCount)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatCount(row.newUsers)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-base-content/60">
        New users are dimensioned per country and not summed into project
        totals. Long-tail countries beyond daily cardinality limits roll into
        (other) without data loss.
      </p>
    </div>
  );
}

export function TechnologySection({
  dimension,
  onDimensionChange,
  result,
  prevResult,
  pending,
  queryError,
}: {
  dimension: "device" | "browser" | "os";
  onDimensionChange: (dim: "device" | "browser" | "os") => void;
  result: AnalyticsTechnologyResult | undefined;
  prevResult?: AnalyticsTechnologyResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  const dimensionLabels: Record<"device" | "browser" | "os", string> = {
    device: "Device category",
    browser: "Browser",
    os: "Operating system",
  };

  const prevSessionsByValue = new Map(
    prevResult?.connected
      ? prevResult.rows.map((row) => [row.value, row.sessions])
      : [],
  );

  return (
    <div className="space-y-3">
      <div className="tabs tabs-boxed max-w-fit">
        <button
          type="button"
          className={`tab tab-sm ${dimension === "device" ? "tab-active" : ""}`}
          onClick={() => onDimensionChange("device")}
        >
          Device
        </button>
        <button
          type="button"
          className={`tab tab-sm ${dimension === "browser" ? "tab-active" : ""}`}
          onClick={() => onDimensionChange("browser")}
        >
          Browser
        </button>
        <button
          type="button"
          className={`tab tab-sm ${dimension === "os" ? "tab-active" : ""}`}
          onClick={() => onDimensionChange("os")}
        >
          Operating system
        </button>
      </div>

      {pending ? (
        <SectionLoading label={dimensionLabels[dimension].toLowerCase()} />
      ) : queryError ? (
        <SectionError error={queryError} />
      ) : !result || !result.connected ? null : result.rows.length === 0 ? (
        <div className="p-4 text-sm text-base-content/60">
          {result.emptyNote ??
            `No ${dimensionLabels[dimension].toLowerCase()} data for this period.`}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <caption className="sr-only">
                {dimensionLabels[dimension]} breakdown
              </caption>
              <thead>
                <tr>
                  <th>{dimensionLabels[dimension]}</th>
                  <th className="text-right">Sessions</th>
                  {prevResult?.connected ? (
                    <th className="text-right">Change</th>
                  ) : null}
                  <th className="text-right">Engaged sessions</th>
                  <th className="text-right">Engagement rate</th>
                  <th className="text-right">Avg engagement time</th>
                  <th className="text-right">Page views</th>
                  <th className="text-right">Events</th>
                  <th className="text-right">New users</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const prevSessions = prevSessionsByValue.get(row.value);
                  const change =
                    prevSessions !== undefined
                      ? row.sessions - prevSessions
                      : null;
                  const pctChange =
                    prevSessions !== undefined
                      ? prevSessions === 0
                        ? row.sessions === 0
                          ? 0
                          : 100
                        : ((row.sessions - prevSessions) / prevSessions) * 100
                      : null;
                  const engagementRate =
                    row.sessions > 0 ? row.engagedSessions / row.sessions : 0;
                  const avgTime =
                    row.sessions > 0
                      ? row.userEngagementDuration / row.sessions
                      : 0;

                  return (
                    <tr key={row.value}>
                      <td>
                        {row.isOtherRow || row.value === "(other)" ? (
                          <span className="flex items-center gap-1.5">
                            <span className="badge badge-neutral badge-xs">
                              Aggregated
                            </span>
                            <span className="italic text-base-content/70">
                              (other)
                            </span>
                          </span>
                        ) : (
                          row.value
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatCount(row.sessions)}
                      </td>
                      {prevResult?.connected ? (
                        <td
                          className={`text-right tabular-nums ${
                            change! > 0
                              ? "text-success font-medium"
                              : change! < 0
                                ? "text-error font-medium"
                                : "text-base-content/60"
                          }`}
                        >
                          {formatDelta(change!)} ({formatPctChange(pctChange)})
                        </td>
                      ) : null}
                      <td className="text-right tabular-nums">
                        {formatCount(row.engagedSessions)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatRatioAsPercent(engagementRate)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatSeconds(avgTime)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatCount(row.screenPageViews)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatCount(row.eventCount)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatCount(row.newUsers)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-base-content/60">
            Technology metrics derive from stored daily grains with bounded
            cardinality. Aggregated values beyond bounds appear in (other).
          </p>
        </div>
      )}
    </div>
  );
}
