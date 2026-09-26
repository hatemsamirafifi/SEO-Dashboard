import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  createReportShare,
  getReportShares,
  revokeReportShare,
} from "@/serverFunctions/reports";
import { formatDateTime } from "@/client/features/reports/reportsCopy";

type ShareRow = Awaited<ReturnType<typeof getReportShares>>["shares"][number];

function shareUrl(token: string): string {
  return `${window.location.origin}/r/${token}`;
}

export function ShareReportModal({
  projectId,
  reportId,
  open,
  onClose,
}: {
  projectId: string;
  reportId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [expiresAt, setExpiresAt] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const sharesQuery = useQuery({
    queryKey: ["report-shares", projectId, reportId],
    queryFn: () => getReportShares({ data: { projectId, reportId } }),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createReportShare({
        data: {
          projectId,
          reportId,
          ...(expiresAt
            ? { expiresAt: new Date(expiresAt).toISOString() }
            : {}),
        },
      }),
    onSuccess: (result) => {
      setFreshToken(result.token);
      setExpiresAt("");
      void queryClient.invalidateQueries({
        queryKey: ["report-shares", projectId, reportId],
      });
      toast.success("Share link created.");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to create link"));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (shareId: string) =>
      revokeReportShare({ data: { projectId, shareId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["report-shares", projectId, reportId],
      });
      toast.success("Share link revoked.");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to revoke link"));
    },
  });

  if (!open) return null;
  const shares: ShareRow[] = sharesQuery.data?.shares ?? [];

  const copyToken = (token: string) => {
    void navigator.clipboard.writeText(shareUrl(token)).then(
      () => toast.success("Link copied."),
      () => toast.error("Copy failed — select the link manually."),
    );
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h2 className="text-lg font-semibold">Share report</h2>
        <p className="mt-1 text-sm text-base-content/70">
          Anyone with the link sees this frozen snapshot — no sign-in needed.
          The link itself is the only authorization, so treat it like a
          password.
        </p>

        {freshToken ? (
          <div className="alert alert-success mt-4">
            <div className="w-full">
              <p className="font-medium">
                Copy this link now — it is shown exactly once.
              </p>
              <p className="mt-1 break-all text-sm">{shareUrl(freshToken)}</p>
              <button
                type="button"
                className="btn btn-sm mt-2"
                onClick={() => copyToken(freshToken)}
              >
                <Copy className="h-4 w-4" />
                Copy link
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="form-control">
            <span className="label-text mb-1">Expires (optional)</span>
            <input
              type="date"
              className="input input-bordered w-full"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Create link
          </button>
        </div>

        <h3 className="mt-4 font-medium">Active links</h3>
        {sharesQuery.isPending ? (
          <p className="mt-2 text-sm text-base-content/60">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="mt-2 text-sm text-base-content/60">
            No share links yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {shares.map((share) => (
              <li
                key={share.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-base-300 p-2 text-sm"
              >
                <span>
                  Created {formatDateTime(share.createdAt)}
                  {share.expiresAt
                    ? ` · expires ${formatDateTime(share.expiresAt)}`
                    : ""}
                  {` · ${share.viewCount} views`}
                </span>
                {share.revokedAt ? (
                  <span className="badge badge-ghost badge-sm">Revoked</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(share.id)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
