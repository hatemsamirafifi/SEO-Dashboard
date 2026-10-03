import { createServerFn } from "@tanstack/react-start";
import { AppError } from "@/server/lib/errors";
import { ExportService } from "@/server/features/reports/services/ExportService";
import { ReportService } from "@/server/features/reports/services/ReportService";
import { ReportScheduleService } from "@/server/features/reports/services/ReportScheduleService";
import { ShareService } from "@/server/features/reports/services/ShareService";
import {
  createReportScheduleSchema,
  createReportShareSchema,
  exportReportSchema,
  generateReportSchema,
  listReportSchedulesSchema,
  listReportSharesSchema,
  listReportsSchema,
  reportByIdSchema,
  reportScheduleIdSchema,
  revokeReportShareSchema,
  updateReportScheduleSchema,
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

export const exportReportPdf = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(exportReportSchema)
  .handler(async ({ context, data }) =>
    ExportService.requestExport({
      reportId: data.reportId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      format: data.format,
    }),
  );

export const getExportStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(exportReportSchema)
  .handler(async ({ context, data }) =>
    ExportService.getExportStatus({
      reportId: data.reportId,
      projectId: context.projectId,
      format: data.format,
    }),
  );

// Scheduled email delivery (spec 012, D2b). All five run through the
// existing requireProjectContext middleware — project scoping is enforced
// before the service layer (auth matrix in
// reports.schedules.authorization.test.ts).
export const createReportSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createReportScheduleSchema)
  .handler(async ({ context, data }) => {
    const schedule = await ReportScheduleService.createSchedule({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      reportType: data.type,
      cadence: data.cadence,
      recipients: data.recipients,
      shareId: data.shareId,
    });
    return { schedule };
  });

export const updateReportSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateReportScheduleSchema)
  .handler(async ({ context, data }) => {
    const schedule = await ReportScheduleService.updateSchedule({
      projectId: context.projectId,
      organizationId: context.organizationId,
      id: data.id,
      reportType: data.type,
      cadence: data.cadence,
      recipients: data.recipients,
      shareId: data.shareId,
    });
    return { schedule };
  });

export const pauseReportSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(reportScheduleIdSchema)
  .handler(async ({ context, data }) => {
    const schedule = await ReportScheduleService.pauseSchedule({
      projectId: context.projectId,
      organizationId: context.organizationId,
      id: data.id,
    });
    return { schedule };
  });

export const resumeReportSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(reportScheduleIdSchema)
  .handler(async ({ context, data }) => {
    const schedule = await ReportScheduleService.resumeSchedule({
      projectId: context.projectId,
      organizationId: context.organizationId,
      id: data.id,
    });
    return { schedule };
  });

export const listReportSchedules = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listReportSchedulesSchema)
  .handler(async ({ context }) => {
    const schedules = await ReportScheduleService.listSchedules({
      projectId: context.projectId,
      organizationId: context.organizationId,
    });
    return { schedules };
  });
