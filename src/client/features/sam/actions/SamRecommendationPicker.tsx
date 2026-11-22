import { BidiText } from "@/client/components/chat/bidiText";
import { useState } from "react";
import { CheckSquare, Loader2, ShieldCheck, X } from "lucide-react";
import type {
  SeoAnalysisResult,
  SeoRecommendation,
} from "@/shared/samSeoAnalyst";

export type GeneratedActionPlanPreview = Pick<
  SeoAnalysisResult,
  | "analyzedAt"
  | "sourceAvailability"
  | "recommendations"
  | "limitations"
  | "missingInformation"
>;

export function SamRecommendationPicker({
  analysis,
  isSaving,
  onSaveSelected,
  onClose,
}: {
  analysis: GeneratedActionPlanPreview;
  isSaving: boolean;
  onSaveSelected: (selected: SeoRecommendation[]) => void;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const recommendations = analysis.recommendations ?? [];
  const toggleSelection = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const selectedRecommendations = recommendations.filter((rec) =>
    selectedIds.includes(rec.id),
  );

  return (
    <div
      data-testid="recommendation-picker"
      className="rounded-xl border border-primary/40 bg-base-100 p-5 shadow-md space-y-4"
    >
      <div className="flex items-start justify-between gap-4 border-b border-base-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <h3 className="text-base font-bold">
              Generated SEO Recommendations ({recommendations.length})
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-base-content/60">
            Select specific evidence-backed recommendations to persist into your
            Action Plan. Nothing is saved until you confirm.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost btn-xs btn-square"
          aria-label="Close recommendations"
        >
          <X className="size-4" />
        </button>
      </div>

      {recommendations.length === 0 ? (
        <p className="text-sm text-base-content/60 py-4 text-center">
          No new recommendations generated from current project evidence.
        </p>
      ) : (
        <div className="space-y-3">
          {recommendations.map((rec) => {
            const alreadySaved = Boolean(rec.existingActionItem);
            const isChecked = selectedIds.includes(rec.id);
            return (
              <label
                key={rec.id}
                data-testid="recommendation-option"
                className={`flex items-start gap-3 rounded-lg border p-3.5 transition-colors ${
                  alreadySaved
                    ? "border-base-200 bg-base-200/40 opacity-60 cursor-not-allowed"
                    : isChecked
                      ? "border-primary bg-primary/5 cursor-pointer"
                      : "border-base-300 hover:border-primary/50 cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary checkbox-sm mt-0.5"
                  disabled={alreadySaved || isSaving}
                  checked={isChecked}
                  onChange={() => toggleSelection(rec.id)}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`badge badge-xs font-semibold ${
                        rec.priority === "Critical"
                          ? "badge-error"
                          : rec.priority === "High"
                            ? "badge-warning"
                            : rec.priority === "Medium"
                              ? "badge-info"
                              : "badge-ghost"
                      }`}
                    >
                      {rec.priority}
                    </span>
                    <span className="badge badge-outline badge-xs">
                      {rec.confidence.level} ({rec.confidence.score}%)
                    </span>
                    {rec.evidenceQuality ? (
                      <span className="badge badge-ghost badge-xs">
                        {rec.evidenceQuality.signalStrength.replace(/_/g, " ")}
                      </span>
                    ) : null}
                    {alreadySaved ? (
                      <span className="badge badge-success badge-xs text-white">
                        Saved ({rec.existingActionItem?.status})
                      </span>
                    ) : null}
                  </div>
                  <div
                    dir="auto"
                    className="wrap-anywhere text-sm font-semibold"
                  >
                    <BidiText text={rec.title} />
                  </div>
                  <p
                    dir="auto"
                    className="wrap-anywhere text-xs text-base-content/70"
                  >
                    <BidiText text={rec.explanation} />
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-base-content/60 pt-1">
                    {rec.baselineMeasurement ? (
                      <span>
                        Baseline: <bdi>{rec.baselineMeasurement}</bdi>
                      </span>
                    ) : null}
                    <span>
                      Evidence: {rec.evidenceReferences.length} source(s)
                    </span>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 pt-3">
        <span className="text-xs font-medium text-base-content/70">
          {selectedRecommendations.length} recommendation(s) selected
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selectedRecommendations.length === 0 || isSaving}
            onClick={() => onSaveSelected(selectedRecommendations)}
            className="btn btn-primary btn-sm gap-1.5"
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckSquare className="size-4" />
            )}
            Save Selected ({selectedRecommendations.length}) to Action Plan
          </button>
        </div>
      </div>
    </div>
  );
}
