import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  getSerpProviderSettings,
  removeSerpProviderSettingsFn,
  saveSerpProviderSettingsFn,
  testSerpProviderConnectionFn,
  type SerpProviderConnectionTestResult,
} from "@/serverFunctions/serpProviderSettings";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatSource } from "./DataforseoSettingsParts";
import { formatCircuitRetryAfter } from "./ProviderCircuitStatus";

export function AdditionalSerpProviderCard({
  provider,
  projectId,
}: {
  provider: "serper" | "zenserp";
  projectId?: string;
}) {
  const label = provider === "serper" ? "Serper.dev" : "Zenserp";
  const queryClient = useQueryClient();
  const queryKey = ["serpProviderSettings", provider, projectId ?? null];
  const query = useQuery({
    queryKey,
    queryFn: () => getSerpProviderSettings({ data: { provider, projectId } }),
  });
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [circuitBreaker, setCircuitBreaker] = useState(true);
  const [priority, setPriority] = useState(provider === "serper" ? 2 : 3);
  const [test, setTest] = useState<SerpProviderConnectionTestResult | null>(
    null,
  );
  const [lastTested, setLastTested] = useState<Date | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.override?.enabled ?? query.data.enabled);
    setCircuitBreaker(
      query.data.override?.circuitBreakerEnabled ??
        query.data.circuitBreakerEnabled,
    );
    setPriority(query.data.override?.priority ?? query.data.priority);
    setApiKey("");
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      saveSerpProviderSettingsFn({
        data: {
          provider,
          projectId,
          patch: {
            apiKey: apiKey || undefined,
            enabled,
            circuitBreakerEnabled: circuitBreaker,
            priority,
          },
        },
      }),
    onSuccess: async () => {
      toast.success(`${label} settings saved`);
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, `Failed to save ${label}`)),
  });
  const remove = useMutation({
    mutationFn: () =>
      removeSerpProviderSettingsFn({ data: { provider, projectId } }),
    onSuccess: async () => {
      toast.success(`${label} override removed`);
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const connection = useMutation({
    mutationFn: () =>
      testSerpProviderConnectionFn({
        data: { provider, projectId, apiKey: apiKey || undefined },
      }),
    onSuccess: async (result) => {
      setTest(result);
      setLastTested(new Date());
      if (result.ok) {
        toast.success(`${label} connected`);
      } else {
        toast.error(`${label}: ${result.reason}`);
      }
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, `Failed to test ${label}`)),
  });

  if (query.isPending)
    return (
      <div className="rounded-box border border-base-300 p-5">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  const data = query.data;
  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">{label}</h3>
          <p className="mt-1 text-xs text-base-content/60">
            Google organic SERP fallback provider. Actual USD cost is not
            available from search responses.
          </p>
        </div>
        <span className="badge badge-outline h-auto whitespace-nowrap py-1">
          Priority {priority}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg bg-base-200/50 p-3 text-xs sm:grid-cols-5">
        <div>
          <span className="block text-base-content/50">Status</span>
          <span className={test?.ok ? "text-success" : ""}>
            {data?.circuit.state === "open"
              ? "Temporarily bypassed"
              : test
                ? test.ok
                  ? "Connected"
                  : test.reason.replaceAll("_", " ")
                : data?.configured
                  ? "Configured"
                  : "Not configured"}
          </span>
        </div>
        <div>
          <span className="block text-base-content/50">Enabled</span>
          {enabled ? "Yes" : "No"}
        </div>
        <div>
          <span className="block text-base-content/50">Runtime status</span>
          {circuitBreaker === false ? (
            <span>Circuit protection disabled</span>
          ) : data?.circuit.state === "open" ? (
            <span className="text-warning">
              Temporarily bypassed ·{" "}
              {formatCircuitRetryAfter(data.circuit.retryAfterMs)}
            </span>
          ) : (
            "Available"
          )}
        </div>
        <div>
          <span className="block text-base-content/50">Credential source</span>
          {formatSource(data?.source)}
        </div>
        <div>
          <span className="block text-base-content/50">Last tested</span>
          {lastTested ? lastTested.toLocaleTimeString() : "Not tested"}
        </div>
      </div>

      <label className="block text-xs font-medium">
        API Key
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={data?.apiKeyMasked ?? "Enter API key"}
          autoComplete="new-password"
          className="input input-bordered input-sm mt-1.5 w-full font-mono"
        />
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
        <label className="flex items-center gap-2 text-xs">
          Priority
          <input
            type="number"
            min={1}
            max={3}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
            className="input input-bordered input-sm w-20"
          />
        </label>
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
            ? "Automatically bypass this provider temporarily after repeated or deterministic provider failures."
            : "Circuit protection disabled. OpenSEO will retry this provider on each eligible request before moving to fallback providers."}
        </p>
      </div>
      <p className="text-[11px] text-warning">
        Connection test may consume one {label}{" "}
        {provider === "serper" ? "query" : "search"}.
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
            >
              <Trash2 className="size-3.5" /> Clear
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
