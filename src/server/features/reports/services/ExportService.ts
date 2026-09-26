import { waitUntil } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { stableHash } from "@/shared/intelligence";
import { parseBrandingSnapshot } from "@/shared/reports";
import { ReportRepository } from "../repositories/ReportRepository";
import { SharingRepository } from "../repositories/SharingRepository";
import { buildPrintModel } from "./printModel";
import { renderPrintHtml } from "./printHtml";
import { renderPdfDocument } from "./pdfDocument";
import { parseReportPayload } from "./ReportService";

export const EXPORT_FORMATS = ["pdf", "html"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportStatus =
  | { status: "none" }
  | { status: "pending" }
  | { status: "ready"; format: ExportFormat; r2Key: string; sizeBytes: number }
  | { status: "failed"; error: string };

function exportKey(reportId: string, fileName: string): string {
  return `report-exports/${reportId}/${fileName}`;
}

function sidecarKey(reportId: string, format: ExportFormat): string {
  return exportKey(reportId, `latest-${format}.json`);
}

async function readSidecar(
  reportId: string,
  format: ExportFormat,
): Promise<ExportStatus> {
  const object = await env.R2.get(sidecarKey(reportId, format));
  if (!object) return { status: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    return { status: "none" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "none" };
  }
  const record = parsed as { status?: unknown; error?: unknown };
  if (record.status === "ready") {
    const ready = parsed as {
      r2Key?: unknown;
      sizeBytes?: unknown;
    };
    return typeof ready.r2Key === "string" &&
      typeof ready.sizeBytes === "number"
      ? { status: "ready", format, r2Key: ready.r2Key, sizeBytes: ready.sizeBytes }
      : { status: "none" };
  }
  if (record.status === "failed") {
    return {
      status: "failed",
      error: typeof record.error === "string" ? record.error : "EXPORT_FAILED",
    };
  }
  return { status: "pending" };
}

async function writeSidecar(
  reportId: string,
  format: ExportFormat,
  status: ExportStatus,
): Promise<void> {
  await env.R2.put(
    sidecarKey(reportId, format),
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function requestExport(input: {
  reportId: string;
  projectId: string;
  organizationId: string;
  userId?: string;
  format: ExportFormat;
}): Promise<ExportStatus> {
  const report = await ReportRepository.getByIdForProject(
    input.reportId,
    input.projectId,
  );
  if (!report) throw new AppError("NOT_FOUND", "Report not found");
  // Content-addressed bytes: re-exporting an unchanged snapshot reuses the
  // stored object instead of rendering again.
  const contentHash = await stableHash(report.payloadSnapshotJson);
  const extension = input.format === "pdf" ? "pdf" : "html";
  const fileName = `report-${report.type}-${report.periodFrom}-${report.periodTo}-${contentHash.slice(0, 16)}.${extension}`;
  const r2Key = exportKey(report.id, fileName);
  const existing = await env.R2.head(r2Key);
  if (existing) {
    return {
      status: "ready",
      format: input.format,
      r2Key,
      sizeBytes: existing.size,
    };
  }
  await writeSidecar(report.id, input.format, { status: "pending" });
  waitUntil(
    (async () => {
      try {
        const payload = parseReportPayload(report);
        const branding = parseBrandingSnapshot(report.brandingSnapshotJson);
        const model = buildPrintModel(payload, branding);
        const body =
          input.format === "pdf"
            ? renderPdfDocument(model).bytes
            : renderPrintHtml(model);
        await env.R2.put(r2Key, body, {
          httpMetadata: {
            contentType:
              input.format === "pdf" ? "application/pdf" : "text/html",
          },
        });
        await captureServerEvent({
          distinctId: input.userId ?? input.organizationId,
          event: "report:export_pdf",
          organizationId: input.organizationId,
          properties: {
            project_id: input.projectId,
            report_id: report.id,
            format: input.format,
            size_bytes: body.length,
          },
        });
        await SharingRepository.insertEvent({
          id: crypto.randomUUID(),
          reportId: report.id,
          organizationId: input.organizationId,
          type: "exported_pdf",
          userId: input.userId ?? null,
          metadataJson: JSON.stringify({ format: input.format }),
        });
        await writeSidecar(report.id, input.format, {
          status: "ready",
          format: input.format,
          r2Key,
          sizeBytes: body.length,
        });
      } catch (error) {
        // Failures surface as status with a code — never payload text or PII.
        const code =
          error instanceof AppError ? error.code : "EXPORT_FAILED";
        await writeSidecar(report.id, input.format, {
          status: "failed",
          error: code,
        }).catch((sidecarError: unknown) => {
          console.error("reports: export sidecar write failed", sidecarError);
        });
      }
    })(),
  );
  return { status: "pending" };
}

export async function getExportStatus(input: {
  reportId: string;
  projectId: string;
  format: ExportFormat;
}): Promise<ExportStatus> {
  const report = await ReportRepository.getByIdForProject(
    input.reportId,
    input.projectId,
  );
  if (!report) throw new AppError("NOT_FOUND", "Report not found");
  return readSidecar(report.id, input.format);
}

/** Authenticated download: verifies project scope, then streams R2 bytes. */
export async function downloadExport(input: {
  reportId: string;
  projectId: string;
  format: ExportFormat;
}): Promise<{ body: ReadableStream | string; contentType: string; fileName: string } | null> {
  const report = await ReportRepository.getByIdForProject(
    input.reportId,
    input.projectId,
  );
  if (!report) return null;
  const status = await readSidecar(report.id, input.format);
  if (status.status !== "ready") return null;
  const object = await env.R2.get(status.r2Key);
  if (!object) return null;
  const fileName = status.r2Key.split("/").at(-1) ?? `report.${input.format}`;
  return {
    body: object.body,
    contentType:
      input.format === "pdf" ? "application/pdf" : "text/html",
    fileName,
  };
}

export const ExportService = {
  requestExport,
  getExportStatus,
  downloadExport,
};
