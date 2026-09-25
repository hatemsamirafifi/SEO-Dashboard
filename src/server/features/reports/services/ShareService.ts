import { waitUntil } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { stableHash } from "@/shared/intelligence";
import {
  parseBrandingSnapshot,
  type BrandingSnapshot,
  type ReportPayload,
} from "@/shared/reports";
import { ReportRepository } from "../repositories/ReportRepository";
import { SharingRepository } from "../repositories/SharingRepository";
import { parseReportPayload } from "./ReportService";

const SHARE_TOKEN_BYTES = 32;
const RAW_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validateExpiresAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new AppError("VALIDATION_ERROR", "Share expiry must be an ISO date");
  }
  if (parsed <= Date.now()) {
    throw new AppError("VALIDATION_ERROR", "Share expiry must be in the future");
  }
  return value;
}

async function recordEvent(input: {
  reportId: string;
  organizationId: string | null;
  type: "shared" | "revoked" | "viewed";
  userId?: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  await SharingRepository.insertEvent({
    id: crypto.randomUUID(),
    reportId: input.reportId,
    organizationId: input.organizationId,
    type: input.type,
    userId: input.userId ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  });
}

export async function createReportShare(input: {
  reportId: string;
  projectId: string;
  organizationId: string;
  userId?: string;
  expiresAt?: string;
}): Promise<{ shareId: string; token: string; expiresAt: string | null }> {
  const report = await ReportRepository.getByIdForProject(
    input.reportId,
    input.projectId,
  );
  if (!report) throw new AppError("NOT_FOUND", "Report not found");
  const expiresAt = validateExpiresAt(input.expiresAt);
  const token = toHex(crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES)));
  const share = await SharingRepository.insertShare({
    id: crypto.randomUUID(),
    reportId: report.id,
    organizationId: input.organizationId,
    tokenHash: await stableHash(token),
    createdByUserId: input.userId ?? null,
    expiresAt,
  });
  await recordEvent({
    reportId: report.id,
    organizationId: input.organizationId,
    type: "shared",
    userId: input.userId,
    metadata: { shareId: share.id },
  });
  waitUntil(
    captureServerEvent({
      distinctId: input.userId ?? input.organizationId,
      event: "report:share",
      organizationId: input.organizationId,
      properties: { project_id: input.projectId, report_id: report.id },
    }),
  );
  // The raw token is returned exactly once — only its hash is stored.
  return { shareId: share.id, token, expiresAt };
}

export async function listReportShares(input: {
  reportId: string;
  projectId: string;
}) {
  const report = await ReportRepository.getByIdForProject(
    input.reportId,
    input.projectId,
  );
  if (!report) throw new AppError("NOT_FOUND", "Report not found");
  const shares = await SharingRepository.listSharesByReport(report.id);
  return shares.map((share) => ({
    id: share.id,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    viewCount: share.viewCount,
    createdAt: share.createdAt,
  }));
}

export async function revokeReportShare(input: {
  shareId: string;
  projectId: string;
  organizationId: string;
  userId?: string;
}): Promise<{ revokedAt: string }> {
  const share = await SharingRepository.findShareById(input.shareId);
  if (!share) throw new AppError("NOT_FOUND", "Share not found");
  const report = await ReportRepository.getByIdForProject(
    share.reportId,
    input.projectId,
  );
  if (!report) throw new AppError("NOT_FOUND", "Share not found");
  // Idempotent: an already-revoked share returns its timestamp with no
  // duplicate events or telemetry.
  if (share.revokedAt) return { revokedAt: share.revokedAt };
  const revoked =
    (await SharingRepository.revokeShare(
      share.id,
      new Date().toISOString(),
    )) ?? share;
  await recordEvent({
    reportId: report.id,
    organizationId: input.organizationId,
    type: "revoked",
    userId: input.userId,
    metadata: { shareId: share.id },
  });
  waitUntil(
    captureServerEvent({
      distinctId: input.userId ?? input.organizationId,
      event: "report:revoke",
      organizationId: input.organizationId,
      properties: { project_id: input.projectId, report_id: report.id },
    }),
  );
  return { revokedAt: revoked.revokedAt ?? new Date().toISOString() };
}

export type PublicReportView = {
  report: {
    id: string;
    type: string;
    periodFrom: string;
    periodTo: string;
    createdAt: string;
    consistencyStatus: string;
  };
  payload: ReportPayload;
  branding: BrandingSnapshot;
};

/**
 * Sole unauthenticated read path (final-plan §15): token-hash lookup only,
 * called from the public `r/$token` route loader. The token is the entire
 * authorization — revoked, expired, malformed, or missing tokens all resolve
 * to null (the loader renders 404 without distinguishing).
 */
export async function getPublicReportByToken(
  token: string,
): Promise<PublicReportView | null> {
  if (!RAW_TOKEN_PATTERN.test(token.trim())) return null;
  const share = await SharingRepository.findShareByTokenHash(
    await stableHash(token.trim()),
  );
  if (!share || share.revokedAt) return null;
  if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now()) return null;
  // Project scoping is intentionally absent: possession of the token
  // authorizes this read, and the share row pins the exact report.
  const report = await ReportRepository.getById(share.reportId);
  if (!report) return null;
  let payload: ReportPayload;
  try {
    payload = parseReportPayload(report);
  } catch (error) {
    console.error("reports: public view refused corrupt payload", error);
    return null;
  }
  // View accounting must never block the shared page itself.
  try {
    await SharingRepository.incrementViewCount(share.id);
    await recordEvent({
      reportId: report.id,
      organizationId: share.organizationId,
      type: "viewed",
      metadata: { shareId: share.id },
    });
  } catch (error) {
    console.error("reports: public view accounting failed", error);
  }
  return {
    report: {
      id: report.id,
      type: report.type,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      createdAt: report.createdAt,
      consistencyStatus: report.consistencyStatus,
    },
    payload,
    branding: parseStoredBrandingSnapshot(report.brandingSnapshotJson),
  };
}

export function parseStoredBrandingSnapshot(
  json: string | null,
): BrandingSnapshot | null {
  return parseBrandingSnapshot(json);
}

export const ShareService = {
  createReportShare,
  listReportShares,
  revokeReportShare,
  getPublicReportByToken,
};
