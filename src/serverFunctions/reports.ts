import { createServerFn } from "@tanstack/react-start";
import { AppError } from "@/server/lib/errors";
import { ReportService } from "@/server/features/reports/services/ReportService";
import { ShareService } from "@/server/features/reports/services/ShareService";
import {
  createReportShareSchema,
  generateReportSchema,
  listReportSharesSchema,
  listReportsSchema,
  reportByIdSchema,
  revokeReportShareSchema,
} from "@/types/schemas/reports";
import { requireProjectContext } from "./middleware";

/**
 * Immutable report snapshots (final-plan §15). Generation reads stored data
 * inline (no queue); sharing and PDF export belong to Tasks 13/14.
 */
export const listReports = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listReportsSchema)
  .handler(async ({ context }) => {
    const rows = await ReportService.listReports({
      projectId: context.projectId,
    });
    return { reports: rows };
  });

export const generateReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(generateReportSchema)
  .handler(async ({ context, data }) => {
    const report = await ReportService.generateReport({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      domain: context.project.domain,
      type: data.type,
      period: data.period,
      strict: data.strict,
    });
    return { report };
  });

export const getReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(reportByIdSchema)
  .handler(async ({ context, data }) => {
    const result = await ReportService.getReport({
      id: data.id,
      projectId: context.projectId,
    });
    if (!result) {
      throw new AppError("NOT_FOUND");
    }
    return result;
  });

export const deleteReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(reportByIdSchema)
  .handler(async ({ context, data }) => {
    const deleted = await ReportService.deleteReport({
      id: data.id,
      projectId: context.projectId,
    });
    if (!deleted) {
      throw new AppError("NOT_FOUND");
    }
    return { ok: true as const };
  });

export const createReportShare = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createReportShareSchema)
  .handler(async ({ context, data }) =>
    ShareService.createReportShare({
      reportId: data.reportId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      expiresAt: data.expiresAt,
    }),
  );

export const getReportShares = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listReportSharesSchema)
  .handler(async ({ context, data }) => {
    const shares = await ShareService.listReportShares({
      reportId: data.reportId,
      projectId: context.projectId,
    });
    return { shares };
  });

export const revokeReportShare = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(revokeReportShareSchema)
  .handler(async ({ context, data }) =>
    ShareService.revokeReportShare({
      shareId: data.shareId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    }),
  );
