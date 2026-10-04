// Shared building blocks for the dashboard cards. Same visual language as
// the GSC IntegrationCard (rounded-xl, shadow-sm, header row + divider) so
// the embedded SearchConsoleConnectionCard doesn't read as a different
// design system.
export function CardShell({
  title,
  stamp,
  action,
  children,
}: {
  title: string;
  stamp?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        {action}
      </div>
      <div className="border-t border-base-300 p-5">
        {children}
        {stamp ? (
          <p className="mt-4 text-[11px] text-base-content/45">{stamp}</p>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyCardBody({
  message,
  cta,
}: {
  message: string;
  cta: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-base-content/70">{message}</p>
      {cta}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: "success" | "error";
  sub?: React.ReactNode;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "error" ? "text-error" : "";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/60">
        {label}
      </p>
      <p className={`text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </p>
      {sub}
    </div>
  );
}

export function PercentDelta({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  if (previous <= 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (!Number.isFinite(pct)) return null;
  const rounded = Math.round(pct);
  const tone = rounded > 0 ? "text-success" : rounded < 0 ? "text-error" : "";
  return (
    <p className={`text-xs tabular-nums ${tone}`}>
      {rounded > 0 ? "▲" : rounded < 0 ? "▼" : ""} {Math.abs(rounded)}%
    </p>
  );
}

export const moreDetailsClass = "btn btn-ghost btn-xs";

/* Unified section-state renderer (spec 011, A2 — T023). Every dashboard
 * intelligence section renders through this shell: metrics children appear
 * ONLY in data states (ready/partial/stale); every other state renders its
 * explicit honest UI. Failure states always carry a retry affordance and can
 * never render as empty content or zeros. */
export type SectionStateKind =
  | "loading"
  | "ready"
  | "empty"
  | "not_connected"
  | "no_data"
  | "partial"
  | "stale"
  | "api_failed"
  | "permission_failed"
  | "sync_running"
  | "sync_failed";

const DATA_STATES: ReadonlySet<SectionStateKind> = new Set([
  "ready",
  "partial",
  "stale",
]);

export function SectionStateShell({
  state,
  detail,
  freshness,
  emptyMessage,
  noDataMessage,
  notConnectedMessage,
  notConnectedCta,
  onRetry,
  children,
}: {
  state: SectionStateKind;
  /** Honest context line from coverage.detail (sync notes, staleness). */
  detail?: string | null;
  /** Freshness stamp from coverage.freshness (shown when stale). */
  freshness?: string | null;
  /** Synced but zero items (honest empty — never a failure). */
  emptyMessage: string;
  /** Nothing synced yet — distinct from empty (never a measured zero). */
  noDataMessage: string;
  notConnectedMessage: string;
  notConnectedCta?: React.ReactNode;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  if (state === "loading") {
    return (
      <div className="flex flex-col gap-2" aria-busy data-testid="section-loading">
        <div className="skeleton h-6 w-3/4" />
        <div className="skeleton h-6 w-1/2" />
      </div>
    );
  }
  if (
    state === "api_failed" ||
    state === "sync_failed" ||
    state === "permission_failed"
  ) {
    const label =
      state === "permission_failed"
        ? "Access to this data source was denied."
        : state === "sync_failed"
          ? "The latest sync failed."
          : "This section failed to load.";
    return (
      <div className="flex flex-col items-start gap-2" data-testid="section-failed">
        <p className="text-sm text-error">{label}</p>
        {detail ? (
          <p className="text-xs text-base-content/50">{detail}</p>
        ) : null}
        {onRetry ? (
          <button type="button" className="btn btn-xs" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (state === "sync_running") {
    return (
      <div className="flex flex-col gap-2" aria-busy data-testid="section-syncing">
        <div className="skeleton h-6 w-2/3" />
        {detail ? (
          <p className="text-xs text-base-content/50">{detail}</p>
        ) : (
          <p className="text-xs text-base-content/50">Sync is running…</p>
        )}
      </div>
    );
  }
  if (state === "not_connected") {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="section-not-connected">
        <p className="text-sm text-base-content/70">{notConnectedMessage}</p>
        {notConnectedCta}
      </div>
    );
  }
  if (state === "no_data" || state === "empty") {
    return (
      <div className="flex flex-col items-start gap-2" data-testid="section-empty">
        <p className="text-sm text-base-content/70">
          {state === "no_data" ? noDataMessage : emptyMessage}
        </p>
        {detail ? (
          <p className="text-xs text-base-content/50">{detail}</p>
        ) : null}
      </div>
    );
  }
  if (DATA_STATES.has(state)) {
    return (
      <div data-testid="section-ready">
        {children}
        {state !== "ready" ? (
          <p className="mt-2 text-[11px] text-base-content/50">
            {state === "stale"
              ? `Data may be outdated${freshness ? ` — last updated ${freshness}` : ""}.`
              : (detail ?? "Showing partial data.")}
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

export function newLost(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function formatDay(timestamp: string): string {
  const ms = Date.parse(
    // SQLite's current_timestamp default has no timezone marker; treat it as
    // UTC rather than letting the browser parse it as local time.
    /^\d{4}-\d{2}-\d{2} /.test(timestamp)
      ? `${timestamp.replace(" ", "T")}Z`
      : timestamp,
  );
  if (Number.isNaN(ms)) return timestamp;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
