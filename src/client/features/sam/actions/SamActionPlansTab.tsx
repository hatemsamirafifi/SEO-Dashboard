import { BidiText } from "@/client/components/chat/bidiText";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import {
  seoActionPlanQueryOptions,
  invalidateSeoActions,
} from "./samActionQueries";
import {
  generateSeoActionPlan,
  saveSeoRecommendationsBatch,
  transitionSeoActionStatus,
  addSeoActionNote,
  verifySeoActionItem,
} from "@/serverFunctions/seoActions";
import type {
  SeoActionStatus,
  SeoRecommendation,
} from "@/shared/samSeoAnalyst";
import {
  NoteModal,
  HistoryModal,
  EvidenceModal,
  type ActionItemRow,
} from "./SamActionModals";
import { ActionCard } from "./SamActionCard";
import {
  SamRecommendationPicker,
  type GeneratedActionPlanPreview,
} from "./SamRecommendationPicker";

function isEffectivelyVerificationPending(item: ActionItemRow) {
  return (
    item.status === "verification_pending" ||
    (item.status === "verified" &&
      item.verificationOutcome === "insufficient_data")
  );
}

function isEffectivelyVerified(item: ActionItemRow) {
  return (
    item.status === "verified" &&
    item.verificationOutcome !== "insufficient_data"
  );
}

export function SamActionPlansTab({ projectId }: { projectId: string }) {
  const [selectedFilter, setSelectedFilter] = useState<string>("all");
  const [generatedPlan, setGeneratedPlan] =
    useState<GeneratedActionPlanPreview | null>(null);
  const [activeItemForNotes, setActiveItemForNotes] =
    useState<ActionItemRow | null>(null);
  const [activeItemForHistory, setActiveItemForHistory] =
    useState<ActionItemRow | null>(null);
  const [activeItemForEvidence, setActiveItemForEvidence] =
    useState<ActionItemRow | null>(null);
  const [noteText, setNoteText] = useState("");

  const planQuery = useQuery(seoActionPlanQueryOptions(projectId));
  const plan = planQuery.data?.plan;
  const items = planQuery.data?.items ?? [];

  const generateMutation = useMutation({
    mutationFn: () => generateSeoActionPlan({ data: { projectId } }),
    onSuccess: (result) => {
      setGeneratedPlan(result);
    },
  });

  const saveBatchMutation = useMutation({
    mutationFn: (recommendations: SeoRecommendation[]) =>
      saveSeoRecommendationsBatch({
        data: {
          projectId,
          recommendations,
          actionPlanId: plan?.id,
        },
      }),
    onSuccess: () => {
      invalidateSeoActions(projectId);
      setGeneratedPlan(null);
    },
  });

  const transitionMutation = useMutation({
    mutationFn: (variables: {
      itemId: string;
      targetStatus: SeoActionStatus;
      notes?: string;
    }) => transitionSeoActionStatus({ data: { projectId, ...variables } }),
    onSuccess: () => {
      invalidateSeoActions(projectId);
      setActiveItemForNotes(null);
      setNoteText("");
    },
  });

  const noteMutation = useMutation({
    mutationFn: (variables: { itemId: string; notes: string }) =>
      addSeoActionNote({ data: { projectId, ...variables } }),
    onSuccess: () => {
      invalidateSeoActions(projectId);
      setActiveItemForNotes(null);
      setNoteText("");
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (itemId: string) =>
      verifySeoActionItem({ data: { projectId, itemId } }),
    onSuccess: () => {
      invalidateSeoActions(projectId);
    },
  });

  const countByStatus = (status: string) => {
    if (status === "verification_pending") {
      return items.filter(isEffectivelyVerificationPending).length;
    }
    if (status === "verified") {
      return items.filter(isEffectivelyVerified).length;
    }
    return items.filter((item) => item.status === status).length;
  };

  const filteredItems = items.filter((item) => {
    if (selectedFilter === "all") return true;
    if (selectedFilter === "verification_pending") {
      return isEffectivelyVerificationPending(item);
    }
    if (selectedFilter === "verified") {
      return isEffectivelyVerified(item);
    }
    return item.status === selectedFilter;
  });

  if (planQuery.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <PlanHeader
        title={plan?.title ?? "SEO Action Plan"}
        description={
          plan?.description ??
          "Persistent trackable tasks generated from evidence-backed SEO analysis."
        }
        totalCount={items.length}
        countByStatus={countByStatus}
        isGenerating={generateMutation.isPending}
        onGenerate={() => generateMutation.mutate()}
      />

      {generatedPlan ? (
        <SamRecommendationPicker
          analysis={generatedPlan}
          isSaving={saveBatchMutation.isPending}
          onSaveSelected={(selected) => saveBatchMutation.mutate(selected)}
          onClose={() => setGeneratedPlan(null)}
        />
      ) : null}

      {/* Filter Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-base-300 pb-2">
        {[
          { key: "all", label: "All Tasks", count: items.length },
          {
            key: "proposed",
            label: "Proposed",
            count: countByStatus("proposed"),
          },
          {
            key: "accepted",
            label: "Accepted",
            count: countByStatus("accepted"),
          },
          {
            key: "in_progress",
            label: "In Progress",
            count: countByStatus("in_progress"),
          },
          {
            key: "completed",
            label: "Completed",
            count: countByStatus("completed"),
          },
          {
            key: "verification_pending",
            label: "Verification Pending",
            count: countByStatus("verification_pending"),
          },
          {
            key: "verified",
            label: "Verified",
            count: countByStatus("verified"),
          },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSelectedFilter(tab.key)}
            className={`btn btn-xs rounded-full ${
              selectedFilter === tab.key
                ? "btn-neutral"
                : "btn-ghost text-base-content/70"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* Items List */}
      {filteredItems.length === 0 ? (
        <EmptyState
          totalItems={items.length}
          isGenerating={generateMutation.isPending}
          onGenerate={() => generateMutation.mutate()}
        />
      ) : (
        <div className="space-y-4">
          {filteredItems.map((item) => (
            <ActionCard
              key={item.id}
              item={item}
              isPending={
                transitionMutation.isPending || verifyMutation.isPending
              }
              onTransition={(targetStatus, notes) =>
                transitionMutation.mutate({
                  itemId: item.id,
                  targetStatus,
                  notes,
                })
              }
              onVerify={() => verifyMutation.mutate(item.id)}
              onOpenNotes={() => {
                setActiveItemForNotes(item);
                setNoteText("");
              }}
              onOpenHistory={() => setActiveItemForHistory(item)}
              onOpenEvidence={() => setActiveItemForEvidence(item)}
            />
          ))}
        </div>
      )}

      {/* Note Modal */}
      {activeItemForNotes ? (
        <NoteModal
          item={activeItemForNotes}
          noteText={noteText}
          isPending={noteMutation.isPending}
          onChangeNote={setNoteText}
          onClose={() => setActiveItemForNotes(null)}
          onSave={() =>
            noteMutation.mutate({
              itemId: activeItemForNotes.id,
              notes: noteText.trim(),
            })
          }
        />
      ) : null}

      {/* History Modal */}
      {activeItemForHistory ? (
        <HistoryModal
          projectId={projectId}
          item={activeItemForHistory}
          onClose={() => setActiveItemForHistory(null)}
        />
      ) : null}

      {/* Evidence Modal */}
      {activeItemForEvidence ? (
        <EvidenceModal
          projectId={projectId}
          item={activeItemForEvidence}
          onClose={() => setActiveItemForEvidence(null)}
        />
      ) : null}
    </div>
  );
}

function PlanHeader({
  title,
  description,
  totalCount,
  countByStatus,
  isGenerating,
  onGenerate,
}: {
  title: string;
  description: string;
  totalCount: number;
  countByStatus: (status: string) => number;
  isGenerating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 wrap-anywhere">
          <div className="flex items-center gap-2">
            <span className="badge badge-primary badge-sm">Action Plan</span>
            <h2 dir="auto" className="text-xl font-bold tracking-tight">
              <BidiText text={title} />
            </h2>
          </div>
          <p dir="auto" className="mt-1 text-sm text-base-content/70">
            <BidiText text={description} />
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-base-content/50">
            Total Tasks: {totalCount}
          </span>
          <button
            type="button"
            disabled={isGenerating}
            onClick={onGenerate}
            className="btn btn-primary btn-sm gap-1.5"
          >
            {isGenerating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            Generate SEO Action Plan
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div className="rounded-lg bg-base-200/50 p-3 text-center">
          <div className="text-xs font-medium text-base-content/60">
            Proposed
          </div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("proposed")}
          </div>
        </div>
        <div className="rounded-lg bg-base-200/50 p-3 text-center">
          <div className="text-xs font-medium text-base-content/60">
            Accepted
          </div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("accepted")}
          </div>
        </div>
        <div className="rounded-lg bg-primary/10 p-3 text-center text-primary">
          <div className="text-xs font-medium">In Progress</div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("in_progress")}
          </div>
        </div>
        <div className="rounded-lg bg-success/10 p-3 text-center text-success">
          <div className="text-xs font-medium">Completed</div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("completed")}
          </div>
        </div>
        <div className="rounded-lg bg-warning/10 p-3 text-center text-warning">
          <div className="text-xs font-medium">Verification Pending</div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("verification_pending")}
          </div>
        </div>
        <div className="rounded-lg bg-info/10 p-3 text-center text-info">
          <div className="text-xs font-medium">Verified</div>
          <div className="mt-1 text-lg font-semibold">
            {countByStatus("verified")}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  totalItems,
  isGenerating,
  onGenerate,
}: {
  totalItems: number;
  isGenerating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-12 text-center space-y-3">
      <Sparkles className="mx-auto size-8 text-base-content/30" />
      <h3 className="text-base font-semibold">No action items found</h3>
      <p className="text-sm text-base-content/60 max-w-md mx-auto">
        {totalItems === 0
          ? "Generate an SEO action plan from existing project data and explicitly choose which recommendations to track."
          : "No action items match the selected filter."}
      </p>
      {totalItems === 0 ? (
        <button
          type="button"
          disabled={isGenerating}
          onClick={onGenerate}
          className="btn btn-primary btn-sm gap-1.5"
        >
          {isGenerating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          Generate SEO Action Plan
        </button>
      ) : null}
    </div>
  );
}
