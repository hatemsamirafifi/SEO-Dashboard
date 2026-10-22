import {
  AlertCircle,
  CheckCircle,
  Loader2,
  OctagonX,
  TriangleAlert,
} from "lucide-react";

export const SUPPORT_URL = "https://everyapp.dev/support";

export function extractPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// SQLite's current_timestamp default stores UTC without a timezone marker
// ("2026-10-19 12:34:56"); without appending Z, browsers parse it as local
// time and shift self-hosted audit timestamps by the viewer's UTC offset.
// Postgres rows carry a tz marker and pass through untouched.
function parseTimestamp(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
    return `${dateStr}Z`;
  }
  return dateStr;
}

export function formatDate(dateStr: string): string {
  return new Date(parseTimestamp(dateStr)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatStartedAt(dateStr: string): string {
  return new Date(parseTimestamp(dateStr)).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="badge badge-info badge-sm gap-1">
        <Loader2 className="size-3 animate-spin" /> Running
      </span>
    );
  }

  if (status === "completed") {
    return (
      <span className="badge badge-outline badge-sm gap-1 text-success/80 border-success/30 bg-success/5">
        <CheckCircle className="size-3" /> Done
      </span>
    );
  }

  if (status === "cancelled") {
    return (
      <span className="badge badge-warning badge-sm gap-1">
        <OctagonX className="size-3" /> Cancelled
      </span>
    );
  }

  if (status === "completed_partial") {
    return (
      <span className="badge badge-warning badge-sm gap-1">
        <TriangleAlert className="size-3" /> Partial
      </span>
    );
  }

  return (
    <span className="badge badge-error badge-sm gap-1">
      <AlertCircle className="size-3" /> Failed
    </span>
  );
}

export function HttpStatusBadge({ code }: { code: number | null }) {
  if (!code) return <span className="badge badge-ghost badge-sm">-</span>;
  if (code >= 200 && code < 300) {
    return <span className="badge badge-success badge-sm">{code}</span>;
  }
  if (code >= 300 && code < 400) {
    return <span className="badge badge-warning badge-sm">{code}</span>;
  }
  return <span className="badge badge-error badge-sm">{code}</span>;
}

export function LighthouseScoreBadge({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-xs text-base-content/40">-</span>;
  }
  const color =
    score >= 90 ? "text-success" : score >= 50 ? "text-warning" : "text-error";
  return <span className={`font-medium text-sm ${color}`}>{score}</span>;
}
