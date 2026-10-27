/* eslint-disable max-lines */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { GSC_SELF_HOSTED_SETUP_DOCS_URL } from "@/shared/gsc";
import { formatGoogleAdsCustomerId } from "@/shared/google-ads";
import {
  disconnectGoogleAds,
  discoverGoogleAdsCustomers,
  getGoogleAdsConnectionStatus,
  listGoogleAdsManagerChildren,
  selectGoogleAdsCustomer,
  testGoogleAdsConnection,
} from "@/serverFunctions/google-ads";
import { startGoogleAdsLink } from "./startGoogleAdsLink";
import { GoogleAdsSyncStatus } from "./GoogleAdsSyncStatus";
import type {
  GoogleAdsConnectionStatus,
  GoogleAdsDiscoveredCustomer,
  GoogleAdsDiscoveryResponse,
} from "./googleAdsTypes";

/** Google Ads connection card: connect, pick a customer account (with
 *  expandable manager hierarchies), test, change and disconnect. */

type DiscoveryQuery = {
  data?: GoogleAdsDiscoveryResponse;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

export function GoogleAdsConnectionCard({ projectId }: { projectId: string }) {
  const hosted = isHostedClientAuthMode();
  const queryClient = useQueryClient();
  const [picking, setPicking] = React.useState(false);

  const connectionQuery = useQuery({
    queryKey: ["googleAdsConnection", projectId],
    queryFn: () => getGoogleAdsConnectionStatus({ data: { projectId } }),
  });
  const connection = connectionQuery.data as
    | GoogleAdsConnectionStatus
    | undefined;
  const connected = Boolean(connection?.connected);
  const selfHostedNeedsSetup =
    !hosted && connectionQuery.isSuccess && !connection?.googleOAuthConfigured;

  const showPicker =
    !connected &&
    connectionQuery.isSuccess &&
    Boolean(connection?.currentUserHasGrant) &&
    !selfHostedNeedsSetup;

  const discovery = useQuery({
    queryKey: ["googleAdsDiscovery", projectId],
    queryFn: () => discoverGoogleAdsCustomers({ data: { projectId } }),
    enabled: Boolean(showPicker || (connected && picking)),
    staleTime: 0,
  });

  const invalidate = (message: string) => {
    void queryClient.invalidateQueries({
      queryKey: ["googleAdsConnection", projectId],
    });
    void queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[1] === projectId &&
        typeof query.queryKey[0] === "string" &&
        query.queryKey[0].startsWith("googleAds"),
    });
    toast.success(message);
  };

  const select = useMutation({
    mutationFn: (value: {
      grantAccountId: string;
      customerId: string;
      loginCustomerId?: string;
    }) => selectGoogleAdsCustomer({ data: { projectId, ...value } }),
    onSuccess: () => {
      setPicking(false);
      invalidate("Google Ads account connected.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectGoogleAds({ data: { projectId } }),
    onSuccess: () => {
      setPicking(false);
      invalidate("Google Ads disconnected.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () => testGoogleAdsConnection({ data: { projectId } }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Google Ads connection verified.");
      } else {
        toast.error(`Connection test failed: ${result.errorClass ?? "error"}`);
      }
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const handleConnect = () =>
    void startGoogleAdsLink(projectId, window.location.href);

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
            Could not load the Google Ads connection.
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
        <SelfHostedSetupWarning />
      ) : connection?.connected && !picking ? (
        <ConnectedState
          connection={connection}
          projectId={projectId}
          testing={test.isPending}
          onTest={() => test.mutate()}
          onChange={() => setPicking(true)}
          onReconnect={handleConnect}
          onDisconnect={() => disconnect.mutate()}
          disconnecting={disconnect.isPending}
        />
      ) : showPicker || picking ? (
        <AccountPicker
          projectId={projectId}
          discovery={discovery}
          onSelect={(selection) => select.mutate(selection)}
          selecting={select.isPending}
          onCancel={connected ? () => setPicking(false) : undefined}
          onConnectAnother={handleConnect}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-base-content/70">
            Connect Google Ads to see spend, clicks and conversions alongside
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
// Account picker
// ---------------------------------------------------------------------------

type PickerSelection = {
  grantAccountId: string;
  customerId: string;
  loginCustomerId?: string;
};

function AccountPicker({
  projectId,
  discovery,
  onSelect,
  selecting,
  onCancel,
  onConnectAnother,
}: {
  projectId: string;
  discovery: DiscoveryQuery;
  onSelect: (selection: PickerSelection) => void;
  selecting: boolean;
  onCancel?: () => void;
  onConnectAnother: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-base-content/70">
        Select a Google Ads customer account. Manager accounts expand to pick a
        child account.
      </p>
      {discovery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/50">
          <span className="loading loading-spinner loading-sm" />
          Loading accounts…
        </div>
      ) : discovery.isError ? (
        <div className="space-y-2">
          <p className="text-sm text-error">
            Could not load accessible accounts.
          </p>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            onClick={() => discovery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {discovery.data?.grants.map((grant) => (
            <div key={grant.grantAccountId} className="space-y-2">
              <p className="text-xs text-base-content/50">
                Grant {formatGoogleAdsCustomerId(grant.grantAccountId)}
              </p>
              {grant.failure ? (
                <div className="alert alert-warning items-start justify-between py-2 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <div>
                      <p className="font-semibold">
                        This Google account could not be probed:{" "}
                        {grant.failure.errorClass}
                      </p>
                      {grant.failure.message ? (
                        <p className="mt-0.5 text-base-content/70">
                          {grant.failure.message}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <button
                    className="btn btn-outline btn-xs shrink-0"
                    type="button"
                    onClick={() => void discovery.refetch()}
                    disabled={discovery.isFetching}
                  >
                    {discovery.isFetching ? "Retrying…" : "Retry"}
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {grant.customers.length === 0 ? (
                    <p className="text-sm text-base-content/60">
                      No accessible accounts for this grant.
                    </p>
                  ) : (
                    grant.customers.map((customer) => (
                      <CustomerRow
                        key={customer.customerId}
                        projectId={projectId}
                        grantAccountId={grant.grantAccountId}
                        customer={customer}
                        selecting={selecting}
                        onSelect={onSelect}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
          {discovery.data?.partial ? (
            <p className="text-xs text-warning">
              Some accounts may be missing: the reach of this account list was
              capped or one Google account could not be probed.
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={onConnectAnother}
            >
              Connect another account
            </button>
            {onCancel ? (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerRow({
  projectId,
  grantAccountId,
  customer,
  selecting,
  onSelect,
}: {
  projectId: string;
  grantAccountId: string;
  customer: GoogleAdsDiscoveredCustomer;
  selecting: boolean;
  onSelect: (selection: PickerSelection) => void;
}) {
  if (customer.manager) {
    return (
      <ManagerCustomer
        projectId={projectId}
        grantAccountId={grantAccountId}
        customer={customer}
        selecting={selecting}
        onSelect={onSelect}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={selecting}
      onClick={() =>
        onSelect({
          grantAccountId,
          customerId: customer.customerId,
        })
      }
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-base-300 bg-base-100 px-3.5 py-2.5 text-left text-sm transition hover:bg-base-200"
    >
      <span className="truncate">
        {customer.displayName ?? customer.customerId}{" "}
        <span className="font-mono text-xs text-base-content/60">
          ({customer.formattedId})
        </span>
      </span>
      <span className="flex shrink-0 gap-1">
        <AccountChips customer={customer} />
      </span>
    </button>
  );
}

function AccountChips({ customer }: { customer: GoogleAdsDiscoveredCustomer }) {
  return (
    <>
      {customer.manager ? (
        <span className="badge badge-ghost badge-sm">Manager</span>
      ) : null}
      {customer.isTestAccount ? (
        <span className="badge badge-warning badge-sm">Test account</span>
      ) : null}
      {customer.currencyCode ? (
        <span className="badge badge-ghost badge-sm">
          {customer.currencyCode}
        </span>
      ) : null}
    </>
  );
}

function ManagerCustomer({
  projectId,
  grantAccountId,
  customer,
  selecting,
  onSelect,
}: {
  projectId: string;
  grantAccountId: string;
  customer: GoogleAdsDiscoveredCustomer;
  selecting: boolean;
  onSelect: (selection: PickerSelection) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const children = useQuery({
    queryKey: [
      "googleAdsManagerChildren",
      projectId,
      grantAccountId,
      customer.customerId,
    ],
    queryFn: () =>
      listGoogleAdsManagerChildren({
        data: {
          projectId,
          grantAccountId,
          managerId: customer.customerId,
        },
      }),
    enabled: expanded,
  });
  return (
    <div className="rounded-lg border border-base-300 bg-base-100">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className="truncate">
          {customer.displayName ?? customer.customerId}{" "}
          <span className="font-mono text-xs text-base-content/60">
            ({customer.formattedId})
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <AccountChips customer={customer} />
          <ChevronDown
            className={`size-4 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-base-300 p-2">
          {children.isPending ? (
            <div className="flex items-center gap-2 px-2 py-1 text-sm text-base-content/50">
              <span className="loading loading-spinner loading-xs" />
              Loading sub-accounts…
            </div>
          ) : children.isError || children.data?.failure ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-warning">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span>
                Sub-accounts could not be loaded
                {children.data?.failure
                  ? `: ${children.data.failure.errorClass}`
                  : ""}
                {children.data?.partial ? " (list truncated)" : ""}.
              </span>
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                onClick={() => void children.refetch()}
              >
                Retry
              </button>
            </div>
          ) : (children.data?.children.length ?? 0) === 0 ? (
            <p className="px-2 py-1 text-xs text-base-content/60">
              No sub-accounts under this manager.
            </p>
          ) : (
            children.data?.children.map((child) => (
              <CustomerRow
                key={child.customerId}
                projectId={projectId}
                grantAccountId={grantAccountId}
                customer={child}
                selecting={selecting}
                onSelect={onSelectWithLogin(customer.customerId, onSelect)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function onSelectWithLogin(
  managerId: string,
  onSelect: (selection: PickerSelection) => void,
) {
  return (selection: PickerSelection) =>
    onSelect({ ...selection, loginCustomerId: managerId });
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
        <h2 className="text-base font-semibold leading-tight">Google Ads</h2>
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
  connection,
  testing,
  onTest,
  onChange,
  onReconnect,
  onDisconnect,
  disconnecting,
  projectId,
}: {
  connection: GoogleAdsConnectionStatus;
  testing: boolean;
  onTest: () => void;
  onChange: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  projectId: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-200/40 p-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-md border border-base-300 bg-base-100">
          <GoogleGlyph className="size-[18px]" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">
            {connection.customerDisplayName
              ? `${connection.customerDisplayName} `
              : ""}
            <span className="font-mono text-xs text-base-content/70">
              (
              {connection.customerId
                ? formatGoogleAdsCustomerId(connection.customerId)
                : ""}
              )
            </span>
          </p>
          <p className="truncate text-xs text-base-content/55">
            {[
              connection.isTestAccount ? "Test account" : null,
              connection.currencyCode,
              connection.timeZone,
              connection.connectedByEmail
                ? `Connected by ${connection.connectedByEmail}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onChange}
        >
          Change account
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
      <GoogleAdsSyncStatus projectId={projectId} connected={true} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-hosted setup warning
// ---------------------------------------------------------------------------

function SelfHostedSetupWarning() {
  return (
    <div className="alert alert-warning items-start text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">Google OAuth client not configured</p>
        <p className="text-base-content/70">
          Add your Google client ID and secret to this OpenSEO deployment before
          connecting Google Ads.
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
