import { useEffect, useState } from "react";
import {
  AlertCircle,
  Database,
  DollarSign,
  Eraser,
  Layers,
  Network,
  Search,
  Server,
  Settings,
  TrendingUp,
  X,
  type Filter,
} from "lucide-react";
import type { GlobalTraceFilter } from "@/shared/globalTraceTypes";
import { useGlobalTrace } from "./useGlobalTrace";
import { GlobalTraceOperationCard } from "./GlobalTraceOperationCard";

const FILTERS: Array<{
  id: GlobalTraceFilter;
  label: string;
  icon: typeof Filter;
}> = [
  { id: "all", label: "All", icon: Layers },
  { id: "errors", label: "Errors", icon: AlertCircle },
  { id: "providers", label: "Providers", icon: Server },
  { id: "network", label: "Network", icon: Network },
  { id: "billing", label: "Billing", icon: DollarSign },
  { id: "cache", label: "Cache", icon: Database },
  { id: "rank_tracking", label: "Rank Tracking", icon: TrendingUp },
  { id: "seo", label: "SEO", icon: Search },
  { id: "settings", label: "Settings", icon: Settings },
];

export function GlobalDebugTracePanel({
  projectId,
  onClose,
}: {
  projectId?: string;
  onClose?: () => void;
}) {
  const [scope, setScope] = useState<"project" | "all">(
    projectId ? "project" : "all",
  );

  useEffect(() => {
    if (projectId) {
      setScope("project");
    } else {
      setScope("all");
    }
  }, [projectId]);

  const effectiveProjectId = scope === "project" ? projectId : undefined;

  const {
    operations,
    totalCount,
    activeFilter,
    setActiveFilter,
    clearTrace,
    setPanelOpen,
  } = useGlobalTrace(effectiveProjectId);

  const { totalCount: globalTotalCount } = useGlobalTrace(undefined);

  // Close with Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (onClose) onClose();
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, setPanelOpen]);

  const handleClose = () => {
    if (onClose) onClose();
    setPanelOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity"
      role="dialog"
      aria-labelledby="debug-trace-title"
      aria-modal="true"
    >
      <div className="flex h-full w-full max-w-3xl flex-col bg-base-100 shadow-2xl border-l border-base-300 animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-4">
          <div>
            <div className="flex items-center gap-3">
              <h2
                id="debug-trace-title"
                className="text-lg font-bold tracking-tight text-base-content"
              >
                OpenSEO Debug Trace
              </h2>
              {projectId && (
                <div className="join border border-base-300 rounded-md">
                  <button
                    type="button"
                    onClick={() => setScope("project")}
                    className={`btn btn-xs join-item ${
                      scope === "project"
                        ? "btn-primary"
                        : "btn-ghost text-base-content/70"
                    }`}
                  >
                    Current project
                  </button>
                  <button
                    type="button"
                    onClick={() => setScope("all")}
                    className={`btn btn-xs join-item ${
                      scope === "all"
                        ? "btn-primary"
                        : "btn-ghost text-base-content/70"
                    }`}
                  >
                    All ({globalTotalCount})
                  </button>
                </div>
              )}
            </div>
            <p className="text-xs text-base-content/60">
              Developer diagnostics for non-SAM application operations · Current
              session
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearTrace}
              className="btn btn-ghost btn-xs gap-1.5 text-base-content/70 hover:text-error"
              title="Clear all recorded trace operations for current project"
              disabled={totalCount === 0}
            >
              <Eraser className="size-3.5" />
              Clear Trace
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="btn btn-ghost btn-sm btn-square"
              aria-label="Close Debug Trace panel"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-base-200 bg-base-200/50 px-4 py-2 text-xs scrollbar-none">
          {FILTERS.map((f) => {
            const isActive = activeFilter === f.id;
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setActiveFilter(f.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors ${
                  isActive
                    ? "bg-primary text-primary-content shadow-xs"
                    : "text-base-content/70 hover:bg-base-300 hover:text-base-content"
                }`}
              >
                <Icon className="size-3.5" />
                <span>{f.label}</span>
                {f.id === "all" && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                      isActive
                        ? "bg-primary-content/20 text-primary-content"
                        : "bg-base-300 text-base-content/70"
                    }`}
                  >
                    {totalCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Trace List Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {operations.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Layers className="size-10 text-base-content/20 mb-2" />
              <p className="font-semibold text-base-content">
                No trace operations recorded
              </p>
              <p className="mt-1 max-w-sm text-xs text-base-content/60">
                {totalCount > 0
                  ? `No operations match the "${activeFilter}" filter.`
                  : scope === "project" && globalTotalCount > 0
                    ? `No operations recorded for this project yet (${globalTotalCount} available across all projects).`
                    : "Perform actions in OpenSEO (e.g. Check selected rankings in Rank Tracking, Test DataForSEO connection in Settings) to see diagnostics here."}
              </p>
              {scope === "project" && globalTotalCount > 0 && (
                <button
                  type="button"
                  onClick={() => setScope("all")}
                  className="btn btn-outline btn-xs mt-3 gap-1"
                >
                  View all {globalTotalCount} operations
                </button>
              )}
            </div>
          ) : (
            operations.map((operation) => (
              <GlobalTraceOperationCard
                key={operation.operationId}
                operation={operation}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-base-200 bg-base-200/30 px-4 py-2.5 text-xs text-base-content/60">
          <span>
            {operations.length} of {totalCount} operations visible
            {scope === "project" && globalTotalCount !== totalCount && (
              <span className="ml-1 text-base-content/40">
                ({globalTotalCount} total in session)
              </span>
            )}
          </span>
          <span>Max retention: 500 events (session only)</span>
        </div>
      </div>
    </div>
  );
}
