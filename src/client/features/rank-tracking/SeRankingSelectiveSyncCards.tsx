import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
  Table2,
} from "lucide-react";
import type {
  confirmSeRankingSelectiveSync,
  previewSeRankingSelectiveSync,
} from "@/serverFunctions/seranking-selective-sync";
import type {
  SeRankingEngineMode,
  SeRankingSelectiveSyncPlan,
} from "@/shared/seranking-selective-sync";

type PreviewResponse = Awaited<
  ReturnType<typeof previewSeRankingSelectiveSync>
>;
type ConfirmResult = Awaited<ReturnType<typeof confirmSeRankingSelectiveSync>>;

const ENGINE_MODE_ITEMS: Array<{
  value: SeRankingEngineMode;
  label: string;
  icon: React.ReactNode;
  hint: string;
}> = [
  {
    value: "assignments",
    label: "Assignments",
    icon: <Table2 className="size-3.5" />,
    hint: "Each keyword's own target assignments (default)",
  },
  {
    value: "desktop",
    label: "Desktop",
    icon: <Monitor className="size-3.5" />,
    hint: "Only the desktop search engine",
  },
  {
    value: "mobile",
    label: "Mobile",
    icon: <Smartphone className="size-3.5" />,
    hint: "Only the mobile search engine",
  },
  {
    value: "both",
    label: "Both",
    icon: <CloudUpload className="size-3.5" />,
    hint: "Desktop and mobile search engines",
  },
];

function StatCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "warning" | "unknown";
}) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-200/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-base-content/55">
        {label}
      </p>
      <p
        className={`font-mono text-sm font-semibold ${
          tone === "warning"
            ? "text-warning"
            : tone === "unknown"
              ? "text-base-content/40"
              : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function SyncPreview({
  preview,
  plan,
  engineMode,
  onEngineModeChange,
  pending,
  disabled,
  onConfirm,
  onClose,
}: {
  preview: PreviewResponse;
  plan: SeRankingSelectiveSyncPlan;
  engineMode: SeRankingEngineMode;
  onEngineModeChange: (mode: SeRankingEngineMode) => void;
  pending: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const keywordRowsNeedingAdd = plan
    ? plan.keywords.filter((k) => k.classification === "missing_remote")
    : [];
  const blockedCount = plan
    ? plan.keywords.filter((k) => k.action === "blocked").length
    : 0;

  return (
    <div className="space-y-4" data-testid="seranking-sync-preview">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-200/40 px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate flex items-center gap-1.5">
            <ExternalLink className="size-3.5 text-base-content/50 shrink-0" />
            {preview.remoteProject?.title}
          </p>
          <p className="text-xs text-base-content/55">
            SE Ranking site ID{" "}
            <span className="font-mono">{preview.remoteProject?.siteId}</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <StatCell label="Selected keywords" value={preview.selectedCount} />
        <StatCell label="Already remote" value={plan.counts.alreadyRemote} />
        <StatCell
          label="Already mapped"
          value={plan.counts.alreadyMappedLocally}
        />
        <StatCell label="Missing remotely" value={plan.counts.missingRemote} />
        <StatCell
          label="Missing Desktop"
          value={
            plan.counts.missingDesktopAssignments === null
              ? "?"
              : plan.counts.missingDesktopAssignments
          }
          tone={
            plan.counts.missingDesktopAssignments === null
              ? "unknown"
              : "default"
          }
        />
        <StatCell
          label="Missing Mobile"
          value={
            plan.counts.missingMobileAssignments === null
              ? "?"
              : plan.counts.missingMobileAssignments
          }
          tone={
            plan.counts.missingMobileAssignments === null
              ? "unknown"
              : "default"
          }
        />
        <StatCell
          label="Est. added capacity"
          value={plan.counts.estimatedAdditionalEngineSlots}
        />
        <StatCell label="Fully synced" value={plan.counts.fullySynced} />
        <StatCell
          label="Unknown"
          value={plan.counts.unknown}
          tone={plan.counts.unknown > 0 ? "warning" : "default"}
        />
      </div>

      <div>
        <p className="text-xs uppercase tracking-wide text-base-content/55 mb-1.5">
          Tracking engines
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ENGINE_MODE_ITEMS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`btn btn-sm gap-1.5 ${engineMode === item.value ? "btn-primary" : "btn-ghost border border-base-300"}`}
              onClick={() => onEngineModeChange(item.value)}
              title={item.hint}
              aria-pressed={engineMode === item.value}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-base-content/50 mt-1.5">
          {engineMode === "assignments"
            ? "Default: each keyword syncs the engines of its own target assignments. Keywords without assignments follow this configuration's device setting."
            : ENGINE_MODE_ITEMS.find((i) => i.value === engineMode)?.hint}
        </p>
      </div>

      {(preview.quota?.warnings.length ?? 0) > 0 && (
        <div className="alert alert-warning text-xs py-2">
          <AlertTriangle className="size-4 shrink-0" />
          <ul className="list-disc list-inside space-y-0.5">
            {preview.quota?.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {keywordRowsNeedingAdd.length > 0 && (
        <div className="rounded-lg border border-base-300 overflow-hidden">
          <p className="px-3 py-1.5 text-xs font-medium bg-base-200/60 border-b border-base-300">
            Keywords to add ({keywordRowsNeedingAdd.length})
          </p>
          <ul
            className="text-xs divide-y divide-base-200 max-h-36 overflow-y-auto"
            data-testid="seranking-sync-missing-list"
          >
            {keywordRowsNeedingAdd.map((k) => (
              <li
                key={k.trackingKeywordId}
                className="px-3 py-1.5 flex items-center justify-between gap-2"
              >
                <span className="truncate">{k.keyword}</span>
                {k.action === "blocked" ? (
                  <span
                    className="badge badge-xs badge-warning whitespace-nowrap"
                    title={k.blockedReason ?? undefined}
                  >
                    Blocked
                  </span>
                ) : (
                  <span className="badge badge-xs badge-ghost whitespace-nowrap">
                    {k.requiredEngineIds.length} engine
                    {k.requiredEngineIds.length !== 1 ? "s" : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <p className="text-xs text-base-content/55">
          {plan.counts.keywordsWithWork === 0
            ? "Nothing to do — every keyword in this scope is fully synced."
            : blockedCount > 0
              ? `${blockedCount} keyword(s) cannot be safely modified (see Blocked results after sync).`
              : `This will upload missing keywords to SE Ranking. No rankings are rechecked.`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1.5"
            disabled={disabled}
            onClick={onConfirm}
            data-testid="seranking-sync-confirm"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CloudUpload className="size-3.5" />
            )}
            Confirm — Add Missing Keywords
          </button>
        </div>
      </div>
    </div>
  );
}

export function SyncOutcome({
  confirmResult,
  onBack,
  onClose,
}: {
  confirmResult: ConfirmResult;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="seranking-sync-result">
      <div
        className={`alert ${confirmResult.ok ? "alert-success" : "alert-warning"} text-sm py-2`}
      >
        {confirmResult.ok ? (
          <CheckCircle2 className="size-4 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 shrink-0" />
        )}
        <span>
          {confirmResult.ok
            ? "Selective sync completed."
            : "Selective sync finished with problems. Progress that succeeded was preserved — you can safely retry."}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <StatCell label="Keywords added" value={confirmResult.addedCount} />
        <StatCell
          label="Existing skipped"
          value={confirmResult.skippedExistingCount}
        />
        <StatCell
          label="Mappings repaired"
          value={confirmResult.mappingsRepairedCount}
        />
        <StatCell
          label="Engine assignments updated"
          value={confirmResult.engineAssignmentsUpdatedCount}
        />
        <StatCell
          label="Failed"
          value={confirmResult.failed.length}
          tone={confirmResult.failed.length > 0 ? "warning" : "default"}
        />
        <StatCell
          label="Partially synced"
          value={confirmResult.partiallySynced.length}
          tone={
            confirmResult.partiallySynced.length > 0 ? "warning" : "default"
          }
        />
      </div>

      {confirmResult.failed.length > 0 && (
        <ul className="text-xs text-error space-y-1 max-h-28 overflow-y-auto">
          {confirmResult.failed.map((f) => (
            <li key={`${f.trackingKeywordId}:${f.stage}`}>
              <span className="font-medium">{f.keyword}</span> ({f.stage}
              ): {f.message}
            </li>
          ))}
        </ul>
      )}
      {confirmResult.blocked.length > 0 && (
        <ul className="text-xs text-warning space-y-1 max-h-28 overflow-y-auto">
          {confirmResult.blocked.map((f) => (
            <li key={`${f.trackingKeywordId}:${f.stage}`}>
              <span className="font-medium">{f.keyword}</span>: {f.message}
            </li>
          ))}
        </ul>
      )}
      {confirmResult.unknown.length > 0 && (
        <p className="text-xs text-base-content/60">
          {confirmResult.unknown.length} keyword(s) had an ambiguous result —
          their remote state will be verified on the next preview.
        </p>
      )}
      {confirmResult.staleApprovedKeywordIds.length > 0 && (
        <p className="text-xs text-base-content/60">
          {confirmResult.staleApprovedKeywordIds.length} approved keyword(s) no
          longer exist locally and were skipped.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <RefreshCw className="size-3.5" />
          Back to preview
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onClose}
          data-testid="seranking-sync-done"
        >
          Done
        </button>
      </div>
    </div>
  );
}
