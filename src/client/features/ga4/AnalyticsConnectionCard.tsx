import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { startGa4Link } from "./startGa4Link";
import { shouldShowPropertyPicker } from "./connectionState";
import { propertyListRecovery } from "./propertyListState";
import {
  disconnectGa4,
  getGa4Connection,
  listGa4Properties,
  setGa4Property,
} from "@/serverFunctions/ga4";

export function AnalyticsConnectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = React.useState(false);
  const [selection, setSelection] = React.useState<{
    accountId: string;
    propertyId: string;
  } | null>(null);
  const connection = useQuery({
    queryKey: ["ga4Connection", projectId],
    queryFn: () => getGa4Connection({ data: { projectId } }),
  });
  const shouldList = shouldShowPropertyPicker({
    connected: Boolean(connection.data?.connected),
    picking,
    hasGrant: Boolean(connection.data?.currentUserHasGrant),
  });
  const properties = useQuery({
    queryKey: ["ga4Properties", projectId],
    queryFn: () => listGa4Properties({ data: { projectId } }),
    enabled: shouldList,
  });
  const setProperty = useMutation({
    mutationFn: (value: { accountId: string; propertyId: string }) =>
      setGa4Property({ data: { projectId, ...value } }),
    onSuccess: () => {
      setPicking(false);
      void queryClient.invalidateQueries({
        queryKey: ["ga4Connection", projectId],
      });
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectGa4({ data: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["ga4Connection", projectId],
      });
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const configured = connection.data?.googleOAuthConfigured ?? true;
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
        <h2 className="text-base font-semibold">Google Analytics 4</h2>
        <span className="text-xs text-base-content/60">
          {connection.data?.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="space-y-4 border-t border-base-300 p-5 sm:p-6">
        {connection.isLoading ? (
          <span className="loading loading-spinner loading-sm" />
        ) : connection.isError ? (
          <div className="space-y-2">
            <p className="text-sm text-error">
              Could not load the Analytics connection.
            </p>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={() => void connection.refetch()}
            >
              Retry
            </button>
          </div>
        ) : !configured ? (
          <p className="text-sm text-warning">
            Google OAuth setup is required before Analytics can be connected.
          </p>
        ) : connection.data?.connected && !picking ? (
          <>
            <p className="text-sm text-base-content/70">
              {connection.data.propertyDisplayName} (
              {connection.data.propertyId})
            </p>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setPicking(true)}
              >
                Change property
              </button>
              <button
                className="btn btn-ghost btn-sm text-error"
                type="button"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : shouldList ? (
          <>
            <p className="text-sm text-base-content/70">
              Select a read-only Analytics property.
            </p>
            {properties.isLoading ? (
              <span className="loading loading-spinner loading-sm" />
            ) : properties.isError || properties.data?.failure ? (
              <div>
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
                      ? void startGa4Link(projectId, window.location.href)
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
              <>
                <select
                  className="select select-bordered w-full"
                  value={
                    selection
                      ? `${selection.accountId}:${selection.propertyId}`
                      : ""
                  }
                  onChange={(event) => {
                    const [accountId, propertyId] =
                      event.target.value.split(":");
                    setSelection(
                      accountId && propertyId
                        ? { accountId, propertyId }
                        : null,
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
                      onClick={() =>
                        void startGa4Link(projectId, window.location.href)
                      }
                    >
                      Connect another account
                    </button>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    disabled={!selection || setProperty.isPending}
                    onClick={() => selection && setProperty.mutate(selection)}
                  >
                    Save property
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setPicking(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-base-content/70">
              Connect Google Analytics to select a property. Access is
              read-only.
            </p>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={() => void startGa4Link(projectId, window.location.href)}
            >
              Connect with Google
            </button>
          </>
        )}
      </div>
    </div>
  );
}
