/* eslint-disable max-lines */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { GSC_SELF_HOSTED_SETUP_DOCS_URL } from "@/shared/gsc";
import { startGa4Link } from "./startGa4Link";
import { Ga4SyncStatus } from "./Ga4SyncStatus";
import { shouldShowPropertyPicker } from "./connectionState";
import { propertyListRecovery } from "./propertyListState";
import {
  disconnectGa4,
  getGa4Connection,
  listGa4Properties,
  setGa4Property,
} from "@/serverFunctions/ga4";

export function AnalyticsConnectionCard({ projectId }: { projectId: string }) {
  const hosted = isHostedClientAuthMode();
  const queryClient = useQueryClient();
  const [picking, setPicking] = React.useState(false);
  const [selection, setSelection] = React.useState<{
    accountId: string;
    propertyId: string;
  } | null>(null);

  const connectionQuery = useQuery({
    queryKey: ["ga4Connection", projectId],
    queryFn: () => getGa4Connection({ data: { projectId } }),
  });
  const connection = connectionQuery.data;
  const connected = Boolean(connection?.connected);
  const selfHostedNeedsSetup =
    !hosted && connectionQuery.isSuccess && !connection?.googleOAuthConfigured;

  const shouldList = shouldShowPropertyPicker({
    connected,
    picking,
    hasGrant: Boolean(connection?.currentUserHasGrant),
  });

  const properties = useQuery({
    queryKey: ["ga4Properties", projectId],
    queryFn: () => listGa4Properties({ data: { projectId } }),
    enabled: Boolean(shouldList && !selfHostedNeedsSetup),
  });

  React.useEffect(() => {
    if (selection || !properties.data?.accounts) return;
    for (const account of properties.data.accounts) {
      const match = account.properties.find(
        (p) => p.propertyId === connection?.propertyId,
      );
      if (match) {
        setSelection({
          accountId: account.accountId,
          propertyId: match.propertyId,
        });
        return;
      }
    }
  }, [properties.data?.accounts, connection?.propertyId, selection]);

  const setProperty = useMutation({
    mutationFn: (value: { accountId: string; propertyId: string }) =>
      setGa4Property({ data: { projectId, ...value } }),
    onSuccess: () => {
      setPicking(false);
      void queryClient.invalidateQueries({
        queryKey: ["ga4Connection", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["ga4SyncStatus", projectId],
      });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[1] === projectId &&
          typeof query.queryKey[0] === "string" &&
          (query.queryKey[0].startsWith("analytics") ||
            query.queryKey[0].startsWith("ga4")),
      });
      toast.success("Analytics property updated.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectGa4({ data: { projectId } }),
    onSuccess: () => {
      setPicking(false);
      setSelection(null);
      void queryClient.invalidateQueries({
        queryKey: ["ga4Connection", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["ga4SyncStatus", projectId],
      });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[1] === projectId &&
          typeof query.queryKey[0] === "string" &&
          (query.queryKey[0].startsWith("analytics") ||
            query.queryKey[0].startsWith("ga4")),
      });
      toast.success("Google Analytics 4 disconnected.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const handleConnect = () =>
    void startGa4Link(projectId, window.location.href);

  return (
    <IntegrationCard
      status={
        connectionQuery.isLoading
          ? undefined
          : selfHostedNeedsSetup
            ? "setup_required"
            : connected
              ? "connected"
              : "disconnected"
      }
    >
      {connectionQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/50">
          <span className="loading loading-spinner loading-sm" />
          Checking…
        </div>
      ) : connectionQuery.isError ? (
        <div className="space-y-2">
          <p className="text-sm text-error">
            Could not load the Analytics connection.
          </p>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            onClick={() => void connectionQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : selfHostedNeedsSetup ? (
        <Ga4SelfHostedSetupWarning />
      ) : connected && !picking ? (
        <ConnectedState
          displayName={connection?.propertyDisplayName ?? null}
          propertyId={connection?.propertyId ?? ""}
          connectedByEmail={connection?.connectedByEmail ?? null}
          projectId={projectId}
          onChange={() => {
            setSelection(null);
            setPicking(true);
          }}
          onReconnect={handleConnect}
          onDisconnect={() => disconnect.mutate()}
          disconnecting={disconnect.isPending}
        />
      ) : shouldList ? (
        <div className="space-y-4">
          <p className="text-sm text-base-content/70">
            Select a read-only Google Analytics 4 property.
          </p>
          {properties.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-base-content/50">
              <span className="loading loading-spinner loading-sm" />
              Loading properties…
            </div>
          ) : properties.isError || properties.data?.failure ? (
            <div className="space-y-2">
              <p className="text-sm text-error">
                {
                  propertyListRecovery(properties.data?.failure ?? "provider")
                    .message
                }
              </p>
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={() =>
                  properties.data?.failure === "permission"
                    ? handleConnect()
                    : void properties.refetch()
                }
              >
                {
                  propertyListRecovery(properties.data?.failure ?? "provider")
                    .action
                }
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <select
                className="select select-bordered w-full"
                value={
                  selection
                    ? `${selection.accountId}:${selection.propertyId}`
                    : ""
                }
                onChange={(event) => {
                  const [accountId, propertyId] = event.target.value.split(":");
                  setSelection(
                    accountId && propertyId ? { accountId, propertyId } : null,
                  );
                }}
              >
                <option value="">Choose a property</option>
                {properties.data?.accounts.flatMap((account) =>
                  account.properties.map((property) => (
                    <option
                      key={`${account.accountId}:${property.propertyId}`}
                      value={`${account.accountId}:${property.propertyId}`}
                    >
                      {property.displayName} ({property.propertyId})
                    </option>
                  )),
                )}
              </select>
              {properties.data?.accounts.every(
                (account) => account.properties.length === 0,
              ) ? (
                <div className="space-y-2">
                  <p className="text-sm text-base-content/70">
                    No accessible Analytics properties were found for this
                    account.
                  </p>
                  <button
                    className="btn btn-outline btn-sm"
                    type="button"
                    onClick={handleConnect}
                  >
                    Connect another account
                  </button>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={!selection || setProperty.isPending}
                  onClick={() => selection && setProperty.mutate(selection)}
                >
                  {setProperty.isPending ? (
                    <>
                      <span className="loading loading-spinner loading-xs" />
                      Saving…
                    </>
                  ) : (
                    "Save property"
                  )}
                </button>
                {connected ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setPicking(false)}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm text-error hover:bg-error/10"
                    type="button"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate()}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-base-content/70">
            Connect GA4 to track visitors, conversions, and engagement alongside
            your search performance. Access is read-only.
          </p>
          <button
            type="button"
            onClick={handleConnect}
            className="inline-flex items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm font-semibold text-base-content shadow-sm transition hover:bg-base-200 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <GoogleGlyph className="size-[18px]" />
            Connect with Google
          </button>
        </div>
      )}
    </IntegrationCard>
  );
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

function IntegrationCard({
  status,
  children,
}: {
  status?: "connected" | "disconnected" | "setup_required";
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
        <h2 className="text-base font-semibold leading-tight">
          Google Analytics 4
        </h2>
        {status ? <StatusPill status={status} /> : null}
      </div>
      <div className="border-t border-base-300 p-5 sm:p-6">{children}</div>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "connected" | "disconnected" | "setup_required";
}) {
  const connected = status === "connected";
  const setupRequired = status === "setup_required";
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        connected
          ? "border-success/30 bg-success/10 text-success"
          : setupRequired
            ? "border-warning/30 bg-warning/10 text-warning"
            : "border-base-300 bg-base-200 text-base-content/60",
      ].join(" ")}
    >
      <span
        className={[
          "size-1.5 rounded-full",
          connected
            ? "bg-success"
            : setupRequired
              ? "bg-warning"
              : "bg-base-content/40",
        ].join(" ")}
      />
      {connected
        ? "Connected"
        : setupRequired
          ? "Setup required"
          : "Not connected"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connected state
// ---------------------------------------------------------------------------

function ConnectedState({
  displayName,
  propertyId,
  connectedByEmail,
  projectId,
  onChange,
  onReconnect,
  onDisconnect,
  disconnecting,
}: {
  displayName: string | null;
  propertyId: string;
  connectedByEmail: string | null;
  projectId: string;
  onChange: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-200/40 p-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-base-300 bg-base-100">
          <GoogleGlyph className="size-[18px]" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">
            {displayName ? `${displayName} ` : ""}
            <span className="font-mono text-xs text-base-content/70">
              ({propertyId})
            </span>
          </p>
          {connectedByEmail ? (
            <p className="truncate text-xs text-base-content/55">
              Connected by {connectedByEmail}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onChange}
        >
          Change property
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onReconnect}
        >
          Reconnect
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-error hover:bg-error/10"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          Disconnect
        </button>
      </div>
      <Ga4SyncStatus projectId={projectId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-hosted setup warning
// ---------------------------------------------------------------------------

function Ga4SelfHostedSetupWarning() {
  return (
    <div className="alert alert-warning items-start text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">Google OAuth client not configured</p>
        <p className="text-base-content/70">
          Add your Google client ID and secret to this OpenSEO deployment before
          connecting Google Analytics 4.
        </p>
        <SafeExternalLink
          url={GSC_SELF_HOSTED_SETUP_DOCS_URL}
          label="Open setup guide"
          className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
        />
      </div>
    </div>
  );
}
