import type { GoogleAdsPageView } from "./googleAdsCopy";
import { staleBannerCopy } from "./googleAdsCopy";

/** State banners and empty-state copy for the Google Ads page. Pure and
 *  presentation-only (no router, no queries) so it renders statically in
 *  tests; the page composes it with the sync-status controls. */

const ALERT_TONES: Record<string, string> = {
  info: "alert alert-info",
  warning: "alert alert-warning",
  error: "alert alert-error",
};

/** Alert copy for states that can coexist with visible data. */
export function googleAdsBannerText(
  view: GoogleAdsPageView,
): { tone: "info" | "warning" | "error"; text: string } | null {
  switch (view.kind) {
    case "syncing":
      return {
        tone: "info",
        text: "Syncing Google Ads data… sections below show the last synced snapshot.",
      };
    case "quota-failed":
      return {
        tone: "warning",
        text: `Google Ads sync hit the Google quota and stopped early: ${view.message} Data already synced stays visible.`,
      };
    case "perm-failed":
      return {
        tone: "error",
        text: `Google Ads access failed and needs attention: ${view.message} Reconnect or check account access in Settings.`,
      };
    case "sync-failed":
      return {
        tone: "error",
        text: `Last Google Ads sync failed: ${view.message} Previously synced data stays visible.`,
      };
    case "partial":
      return {
        tone: "warning",
        text: `Partial Google Ads coverage${
          view.coveredThrough ? ` through ${view.coveredThrough}` : ""
        }. Missing dates are excluded, never zeroed.`,
      };
    case "stale":
      return { tone: "warning", text: staleBannerCopy(view) };
    default:
      return null;
  }
}

export function GoogleAdsStateBanner({ view }: { view: GoogleAdsPageView }) {
  const banner = googleAdsBannerText(view);
  if (!banner) return null;
  return (
    <div className={ALERT_TONES[banner.tone]}>
      <span className="text-sm">{banner.text}</span>
    </div>
  );
}

/** Big copy block for states that cannot show any data honestly. */
export function googleAdsFallbackCopy(
  view: GoogleAdsPageView,
): { tone: "info" | "warning" | "error"; title: string; body: string } | null {
  switch (view.kind) {
    case "syncing":
      return {
        tone: "info",
        title: "Syncing Google Ads data…",
        body: "This may take a few moments. Nothing is shown until at least one date reaches successful coverage.",
      };
    case "quota-failed":
      return {
        tone: "warning",
        title: "Sync stopped on quota",
        body: `The last sync hit the Google quota and stopped early: ${view.message} Try again later; already synced data stays available.`,
      };
    case "perm-failed":
      return {
        tone: "error",
        title: "Access needs attention",
        body: `Access failed and needs attention: ${view.message} Reconnect the account or verify API access in Settings.`,
      };
    case "sync-failed":
      return {
        tone: "error",
        title: "Last sync failed",
        body: `The last sync failed: ${view.message} Previously synced data stays visible.`,
      };
    default:
      return null;
  }
}

export function GoogleAdsNoDataCard() {
  return (
    <div className="max-w-2xl rounded-xl border border-base-300 bg-base-100 p-6">
      <h2 className="font-semibold">No Google Ads data yet</h2>
      <p className="mt-1 text-sm text-base-content/60">
        Connect an account and run a sync. Zero-cost days appear as zeros only
        after their dates reach successful coverage — nothing is shown as
        fabricated values in the meantime.
      </p>
    </div>
  );
}
