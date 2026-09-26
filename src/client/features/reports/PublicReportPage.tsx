import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  brandingSnapshotSchema,
  reportPayloadSchema,
  type BrandingSnapshot,
  type ReportPayload,
} from "@/shared/reports";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatPeriod } from "@/client/features/reports/reportsCopy";
import {
  BrandedReportHeader,
  ConsistencyBanner,
  ProvenanceBlock,
  ReportBody,
} from "@/client/features/reports/ReportSections";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type FetchedPublicReport = {
  report: {
    id: string;
    type: string;
    periodFrom: string;
    periodTo: string;
    createdAt: string;
    consistencyStatus: string;
  };
  payload: ReportPayload;
  branding: BrandingSnapshot | null;
};

async function fetchPublicReport(token: string): Promise<FetchedPublicReport> {
  const response = await fetch(
    `/api/public-report?token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This link is invalid, expired, or revoked."
        : "Could not load this shared report.",
    );
  }
  const raw: unknown = await response.json();
  if (!isRecord(raw)) {
    throw new Error("Could not load this shared report.");
  }
  const payload = reportPayloadSchema.safeParse(raw["payload"]);
  const branding = brandingSnapshotSchema.nullable().safeParse(raw["branding"]);
  const meta = raw["report"];
  if (!payload.success || !branding.success || !isRecord(meta)) {
    throw new Error("Could not load this shared report.");
  }
  if (
    typeof meta.type !== "string" ||
    typeof meta.periodFrom !== "string" ||
    typeof meta.periodTo !== "string"
  ) {
    throw new Error("Could not load this shared report.");
  }
  return {
    report: {
      id: typeof meta.id === "string" ? meta.id : "",
      type: meta.type,
      periodFrom: meta.periodFrom,
      periodTo: meta.periodTo,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      consistencyStatus:
        typeof meta.consistencyStatus === "string"
          ? meta.consistencyStatus
          : "consistent",
    },
    payload: payload.data,
    branding: branding.data,
  };
}

export function PublicReportPage({ token }: { token: string }) {
  const viewQuery = useQuery({
    queryKey: ["public-report", token],
    queryFn: () => fetchPublicReport(token),
    retry: false,
  });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 py-8">
      {viewQuery.isPending ? (
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading shared report…
        </div>
      ) : null}
      {viewQuery.isError ? (
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold">Link unavailable</h1>
          <p className="text-sm text-base-content/70">
            {getStandardErrorMessage(
              viewQuery.error,
              "This link is invalid, expired, or revoked.",
            )}
          </p>
        </div>
      ) : null}
      {viewQuery.isSuccess ? (
        <>
          <BrandedReportHeader
            branding={viewQuery.data.branding}
            defaultTitle="Shared SEO report"
            periodLabel={formatPeriod({
              from: viewQuery.data.report.periodFrom,
              to: viewQuery.data.report.periodTo,
            })}
          />
          <ConsistencyBanner payload={viewQuery.data.payload} />
          <ProvenanceBlock payload={viewQuery.data.payload} />
          <ReportBody payload={viewQuery.data.payload} />
          <p className="text-center text-xs text-base-content/50">
            Shared snapshot — the underlying data may have changed since this
            report was generated.
          </p>
        </>
      ) : null}
    </div>
  );
}
