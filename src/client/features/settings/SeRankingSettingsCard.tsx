/* eslint-disable eslint/complexity, eslint/max-lines-per-function */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  getSeRankingSettings,
  removeSeRankingSettingsFn,
  saveSeRankingSettingsFn,
  testSeRankingConnectionFn,
  type SeRankingConnectionTestResult,
} from "@/serverFunctions/serankingSettings";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatSource } from "./DataforseoSettingsParts";
import { formatCircuitRetryAfter } from "./ProviderCircuitStatus";

export function SeRankingSettingsCard({
  projectId,
  initialTestResult = null,
}: {
  projectId?: string;
  initialTestResult?: SeRankingConnectionTestResult | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["seRankingSettings", projectId ?? null];

  const query = useQuery({
    queryKey,
    queryFn: () => getSeRankingSettings({ data: { projectId } }),
  });

  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [circuitBreaker, setCircuitBreaker] = useState(true);
  const [retries, setRetries] = useState(2);
  const [priority, setPriority] = useState(1);
  const [testResult, setTestResult] =
    useState<SeRankingConnectionTestResult | null>(initialTestResult);
  const [lastTested, setLastTested] = useState<Date | null>(
    initialTestResult ? new Date() : null,
  );

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.override?.enabled ?? query.data.enabled);
    setCircuitBreaker(
      query.data.override?.circuitBreakerEnabled ??
        query.data.circuitBreakerEnabled,
    );
    setRetries(query.data.override?.maxRetries ?? query.data.maxRetries);
    setPriority(query.data.override?.priority ?? query.data.priority);
    setApiKey("");
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      saveSeRankingSettingsFn({
        data: {
          projectId,
          patch: {
            apiKey: apiKey.trim() || undefined,
            enabled,
            circuitBreakerEnabled: circuitBreaker,
            maxRetries: retries,
            priority,
          },
        },
      }),
    onSuccess: async () => {
      toast.success("SE Ranking settings saved");
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to save SE Ranking settings")),
  });

  const remove = useMutation({
    mutationFn: () =>
      removeSeRankingSettingsFn({ data: { projectId } }),
    onSuccess: async () => {
      toast.success("SE Ranking override removed");
      setApiKey("");
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to remove SE Ranking settings")),
  });

  const connection = useMutation({
    mutationFn: () =>
      testSeRankingConnectionFn({
        data: { projectId, apiKey: apiKey.trim() || undefined },
      }),
    onSuccess: async (result) => {
      setTestResult(result);
      setLastTested(new Date());
      if (result.ok) {
        toast.success("SE Ranking connected successfully");
      } else {
        toast.error(`SE Ranking test failed: ${result.reason.replaceAll("_", " ")}`);
      }
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to test SE Ranking connection")),
  });

  if (query.isPending) {
    return (
      <div className="rounded-box border border-base-300 p-5">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base">SE Ranking</h3>
            <span className="badge badge-primary badge-sm">Primary Provider</span>
          </div>
          <p className="mt-1 text-xs text-base-content/60">
            Primary SEO intelligence provider for Keyword Research, Domain Analysis, Competitor Discovery, and Backlinks.
          </p>
        </div>
        <span className="badge badge-outline h-auto whitespace-nowrap py-1">
          Priority {priority}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg bg-base-200/50 p-3 text-xs sm:grid-cols-6">
        <div>
          <span className="block text-base-content/50">Status</span>
          <span
            className={
              testResult?.ok
                ? "text-success font-medium"
                : testResult
                  ? "text-error font-medium"
                  : data?.configured
                    ? "text-info font-medium"
                    : "text-base-content/70"
            }
          >
            {data?.circuit.state === "open"
              ? "Temporarily bypassed"
              : testResult
                ? testResult.ok
                  ? "Connected"
                  : testResult.reason.replaceAll("_", " ")
                : data?.configured
                  ? "Configured"
                  : "Not configured"}
          </span>
        </div>
        <div>
          <span className="block text-base-content/50">Enabled</span>
          <span>{enabled ? "Yes" : "No"}</span>
        </div>
        <div>
          <span className="block text-base-content/50">Units left</span>
          <span className="font-mono">
            {testResult?.balance != null
              ? testResult.balance.toLocaleString()
              : data?.configured
                ? "Test to view"
                : "—"}
          </span>
        </div>
        <div>
          <span className="block text-base-content/50">Credential source</span>
          <span>{formatSource(data?.source)}</span>
        </div>
        <div>
          <span className="block text-base-content/50">Circuit health</span>
          {!circuitBreaker ? (
            <span>Protection off</span>
          ) : data?.circuit.state === "open" ? (
            <span className="text-warning">
              Bypassed · {formatCircuitRetryAfter(data.circuit.retryAfterMs)}
            </span>
          ) : (
            <span className="text-success">Healthy</span>
          )}
        </div>
        <div>
          <span className="block text-base-content/50">Last tested</span>
          <span>{lastTested ? lastTested.toLocaleTimeString() : "Not tested"}</span>
        </div>
      </div>

      {testResult && (
        <div
          className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs leading-relaxed ${
            testResult.ok
              ? "border-success/30 bg-success/10 text-success"
              : testResult.reason === "CREDITS_UNAVAILABLE"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "border-error/30 bg-error/10 text-error"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 space-y-1">
            <span className="font-semibold block">
              {testResult.ok
                ? "SE Ranking API connected successfully"
                : `SE Ranking connection failed (${testResult.reason})`}
            </span>
            {testResult.ok && (
              <div className="text-[11px] opacity-90">
                Subscription: <span className="font-semibold">{testResult.subscriptionStatus ?? "Active"}</span>
                {testResult.unitsLimit != null && (
                  <span> · Limit: {testResult.unitsLimit.toLocaleString()} units</span>
                )}
                {testResult.balance != null && (
                  <span> · Available: {testResult.balance.toLocaleString()} units</span>
                )}
              </div>
            )}
            {!testResult.ok && (
              <div className="text-[11px] opacity-90">
                HTTP {testResult.status}: Please verify your SE Ranking API token and subscription status.
              </div>
            )}
          </div>
        </div>
      )}

      <label className="block text-xs font-medium">
        API Token
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={data?.apiKeyMasked ?? "Enter SE Ranking API token"}
          autoComplete="new-password"
          className="input input-bordered input-sm mt-1.5 w-full font-mono"
        />
        <span className="block mt-1 text-[11px] text-base-content/60">
          Personal API token from your SE Ranking account settings. Stored securely with AES-GCM encryption.
        </span>
      </label>

      <div className="flex items-center justify-between gap-4">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs">
            Retries
            <input
              type="number"
              min={0}
              max={5}
              value={retries}
              onChange={(event) =>
                setRetries(Math.min(5, Math.max(0, Number(event.target.value))))
              }
              className="input input-bordered input-sm w-16"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            Priority
            <input
              type="number"
              min={1}
              max={5}
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
              className="input input-bordered input-sm w-20"
            />
          </label>
        </div>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={circuitBreaker}
            onChange={(event) => setCircuitBreaker(event.target.checked)}
          />
          Circuit breaker
        </label>
        <p className="text-[11px] text-base-content/60 leading-relaxed">
          {circuitBreaker
            ? "Automatically bypasses SE Ranking temporarily after repeated failures or rate limit exhaustion."
            : "Circuit protection disabled. OpenSEO will attempt SE Ranking on each request before falling back."}
        </p>
      </div>

      <p className="text-[11px] text-base-content/50">
        Connection test queries the SE Ranking subscription endpoint (costs 0 credits).
      </p>

      <div className="flex flex-wrap justify-between gap-2 border-t border-base-200 pt-4">
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => connection.mutate()}
            disabled={connection.isPending}
          >
            {connection.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}{" "}
            {circuitBreaker && data?.circuit.state === "open"
              ? "Retry now"
              : "Test connection"}
          </button>
          {data?.override && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-error"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              <Trash2 className="size-3.5" /> Clear override
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}{" "}
          Save
        </button>
      </div>
    </div>
  );
}
