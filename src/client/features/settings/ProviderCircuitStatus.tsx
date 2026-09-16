import { AlertTriangle, XCircle } from "lucide-react";
import type { DataforseoSettingsView } from "@/serverFunctions/dataforseoSettings";
import type { DataforseoConnectionTestResult } from "@/serverFunctions/dataforseoSettings";
import { formatSource } from "./DataforseoSettingsParts";

type ProviderCircuitView = DataforseoSettingsView["circuit"];

export function DataforseoStatusCard({
  testResult,
  isConfigured,
  isEnabled,
  circuitBreakerEnabled = true,
  source,
  lastChecked,
  circuit,
}: {
  testResult: DataforseoConnectionTestResult | null;
  isConfigured: boolean;
  isEnabled: boolean;
  circuitBreakerEnabled?: boolean;
  source?: string;
  lastChecked: Date | null;
  circuit?: ProviderCircuitView;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 rounded-lg bg-base-200/50 p-3.5 text-xs">
      <div>
        <span className="text-base-content/50 block font-medium">Status</span>
        <div className="mt-1 flex items-center gap-1.5 font-medium">
          {circuit?.state === "open" ? (
            <span className="flex items-center gap-1 text-warning">
              <AlertTriangle className="size-3" />
              Temporarily bypassed
            </span>
          ) : testResult ? (
            testResult.ok ? (
              <span className="flex items-center gap-1 text-success">
                <span className="inline-block size-2 rounded-full bg-success" />
                Connected
              </span>
            ) : testResult.reason === "CREDITS_UNAVAILABLE" ? (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3" />
                Credits unavailable
              </span>
            ) : testResult.reason === "INVALID_CREDENTIALS" ? (
              <span className="flex items-center gap-1 text-error">
                <XCircle className="size-3" />
                Auth failed
              </span>
            ) : (
              <span className="flex items-center gap-1 text-error">
                <XCircle className="size-3" />
                Failed
              </span>
            )
          ) : !isConfigured ? (
            <span className="text-base-content/50">○ Not configured</span>
          ) : !isEnabled ? (
            <span className="text-base-content/50">○ Disabled</span>
          ) : (
            <span className="flex items-center gap-1 text-success">
              <span className="inline-block size-2 rounded-full bg-success" />
              Configured
            </span>
          )}
        </div>
      </div>

      <div>
        <span className="text-base-content/50 block font-medium">Source</span>
        <div className="mt-1 font-medium text-base-content/80">
          {formatSource(source)}
        </div>
      </div>

      <div>
        <span className="text-base-content/50 block font-medium">Balance</span>
        <div className="mt-1 font-medium tabular-nums">
          {testResult?.balance !== null && testResult?.balance !== undefined ? (
            <span className="text-success font-semibold">
              ${testResult.balance.toFixed(2)}
            </span>
          ) : testResult?.ok ? (
            <span className="text-base-content/60">Unavailable</span>
          ) : (
            <span className="text-base-content/40">—</span>
          )}
        </div>
      </div>

      <div>
        <span className="text-base-content/50 block font-medium">
          Last checked
        </span>
        <div className="mt-1 text-base-content/70">
          {lastChecked ? (
            lastChecked.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          ) : (
            <span className="text-base-content/40">Not checked</span>
          )}
        </div>
      </div>

      <div>
        <span className="text-base-content/50 block font-medium">
          Runtime status
        </span>
        <div className="mt-1 text-base-content/70">
          {circuitBreakerEnabled === false ? (
            "Circuit protection disabled"
          ) : circuit?.state === "open" ? (
            <>
              <div className="font-medium text-warning">
                Temporarily bypassed
              </div>
              <div>
                Retry after {formatCircuitRetryAfter(circuit.retryAfterMs)}
              </div>
            </>
          ) : (
            "Available"
          )}
        </div>
      </div>
    </div>
  );
}

export function formatCircuitReason(reason?: string | null): string {
  if (!reason) return "Unknown provider availability issue";
  return reason
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (value) => value.toUpperCase());
}

export function formatCircuitRetryAfter(retryAfterMs?: number | null): string {
  if (retryAfterMs === null || retryAfterMs === undefined) return "—";
  const seconds = Math.max(0, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ProviderCircuitAlert({
  circuit,
  circuitBreakerEnabled = true,
}: {
  circuit?: ProviderCircuitView;
  circuitBreakerEnabled?: boolean;
}) {
  if (circuitBreakerEnabled === false) return null;
  if (circuit?.state !== "open") return null;
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
      <div className="font-semibold">Runtime status: Temporarily bypassed</div>
      <div className="mt-1">
        Retry after: {formatCircuitRetryAfter(circuit.retryAfterMs)}
      </div>
    </div>
  );
}
