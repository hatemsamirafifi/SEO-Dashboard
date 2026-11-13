import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Plus,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  addRankTrackingTarget,
  retrySeRankingProjectSyncFn,
  toggleRankTrackingTarget,
} from "@/serverFunctions/rank-tracking-targets";
import {
  getIsoCountryCode,
  LANGUAGE_OPTIONS,
  LOCATION_OPTIONS,
} from "@/shared/keyword-locations";
import type { RankTrackingTarget } from "@/types/schemas/rank-tracking";

export function formatTargetLabel(target: RankTrackingTarget): string {
  const geo = target.cityName
    ? `${target.countryCode.toUpperCase()} · ${target.cityName}`
    : `${target.countryCode.toUpperCase()} · Countrywide`;
  return `${geo} (${target.languageCode}) · ${target.device}`;
}

export function RankTrackingTargetsModal({
  projectId,
  configId,
  targets,
  defaultCountryCode,
  defaultLanguageCode,
  onClose,
}: {
  projectId: string;
  configId: string;
  targets: RankTrackingTarget[];
  defaultCountryCode?: string;
  defaultLanguageCode?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [countryCode, setCountryCode] = useState(
    (defaultCountryCode || "us").toLowerCase(),
  );
  const [cityName, setCityName] = useState("");
  const [languageCode, setLanguageCode] = useState(
    (defaultLanguageCode || "en").toLowerCase(),
  );
  const [deviceScope, setDeviceScope] = useState<"desktop" | "mobile" | "both">(
    "desktop",
  );

  const invalidateTargetQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["rankTrackingTargets", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["seRankingSyncStatus"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["rankKeywordTargetAssignments", projectId],
      }),
    ]);
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      const devices: Array<"desktop" | "mobile"> =
        deviceScope === "both" ? ["desktop", "mobile"] : [deviceScope];
      for (const device of devices) {
        await addRankTrackingTarget({
          data: {
            projectId,
            configId,
            countryCode: countryCode.toLowerCase(),
            cityName: cityName.trim() || undefined,
            languageCode: languageCode.toLowerCase(),
            device,
          },
        });
      }
    },
    onSuccess: async () => {
      setCityName("");
      await invalidateTargetQueries();
      toast.success("Tracking target added");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to add target"));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({
      targetId,
      enabled,
    }: {
      targetId: string;
      enabled: boolean;
    }) => toggleRankTrackingTarget({ data: { projectId, targetId, enabled } }),
    onSuccess: async (_res, vars) => {
      await invalidateTargetQueries();
      toast.success(
        vars.enabled
          ? "Target reactivated (history preserved)"
          : "Target disabled (local history & remote resources preserved)",
      );
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to update target"));
    },
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      retrySeRankingProjectSyncFn({ data: { projectId, configId } }),
    onSuccess: async () => {
      await invalidateTargetQueries();
      toast.success("SE Ranking targets synced");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Failed to sync targets with SE Ranking",
        ),
      );
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    addMutation.mutate();
  };

  const countryChoices = LOCATION_OPTIONS.map((loc) => ({
    iso: getIsoCountryCode(loc.code),
    label: loc.label,
  }));

  return (
    <Modal
      onClose={onClose}
      labelledBy="manage-targets-title"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 id="manage-targets-title" className="text-lg font-semibold">
              Multi-Location & Device Targets
            </h3>
            <p className="text-xs text-base-content/60">
              Track distinct countries, cities, search languages, and Desktop /
              Mobile independently. Disabling preserves historical snapshots and
              never issues remote DELETE requests.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-outline btn-xs gap-1 shrink-0"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Sync SE Ranking
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 sm:grid-cols-12 gap-2 rounded-lg border border-base-300 bg-base-200/40 p-3"
        >
          <label className="sm:col-span-4 text-xs font-medium space-y-1">
            <span>Country</span>
            <select
              aria-label="Target country"
              className="select select-bordered select-sm w-full text-xs"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
            >
              {countryChoices.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {c.label} ({c.iso.toUpperCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-3 text-xs font-medium space-y-1">
            <span>City / Region (optional)</span>
            <input
              type="text"
              placeholder="Countrywide"
              className="input input-bordered input-sm w-full text-xs"
              value={cityName}
              onChange={(e) => setCityName(e.target.value)}
            />
          </label>
          <label className="sm:col-span-3 text-xs font-medium space-y-1">
            <span>Language</span>
            <select
              aria-label="Target language"
              className="select select-bordered select-sm w-full text-xs"
              value={languageCode}
              onChange={(e) => setLanguageCode(e.target.value)}
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code.toLowerCase()}>
                  {lang.label} ({lang.code})
                </option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2 text-xs font-medium space-y-1">
            <span>Device</span>
            <select
              aria-label="Target device"
              className="select select-bordered select-sm w-full text-xs"
              value={deviceScope}
              onChange={(e) => {
                const v = e.target.value;
                setDeviceScope(v === "mobile" || v === "both" ? v : "desktop");
              }}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="both">Both</option>
            </select>
          </label>
          <div className="sm:col-span-12 flex justify-end pt-1">
            <button
              type="submit"
              className="btn btn-primary btn-xs gap-1"
              disabled={addMutation.isPending}
            >
              {addMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Add target
            </button>
          </div>
        </form>

        <div className="max-h-72 overflow-y-auto divide-y divide-base-200 rounded-lg border border-base-300">
          {targets.length === 0 ? (
            <p className="p-4 text-xs text-base-content/60 text-center">
              No custom targets configured yet. Add a country, city, language,
              or device target above.
            </p>
          ) : (
            targets.map((target) => (
              <div
                key={target.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {formatTargetLabel(target)}
                    </span>
                    <span
                      className={`badge badge-xs ${
                        target.enabled ? "badge-success" : "badge-ghost"
                      }`}
                    >
                      {target.enabled ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <p className="text-[11px] text-base-content/50 font-mono">
                    {target.searchEngine} · {target.countryCode.toUpperCase()} ·{" "}
                    {target.cityName || "Countrywide"} · {target.languageCode}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs gap-1 shrink-0"
                  disabled={toggleMutation.isPending}
                  onClick={() =>
                    toggleMutation.mutate({
                      targetId: target.id,
                      enabled: !target.enabled,
                    })
                  }
                >
                  {target.enabled ? (
                    <>
                      <ToggleRight className="size-4 text-success" />
                      Disable
                    </>
                  ) : (
                    <>
                      <ToggleLeft className="size-4 text-base-content/50" />
                      Re-enable
                    </>
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
