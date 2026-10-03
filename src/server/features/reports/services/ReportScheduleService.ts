import { AppError } from "@/server/lib/errors";
import {
  REPORT_SCHEDULE_CADENCES,
  REPORT_TYPES,
  type ReportScheduleCadence,
  type ReportType,
} from "@/shared/reports";
import { ReportService } from "./ReportService";
import {
  ReportScheduleRepository,
  type ReportScheduleRow,
} from "../repositories/ReportScheduleRepository";
import { SharingRepository } from "../repositories/SharingRepository";

import { deriveNextDueAt } from "./cadence";

const MAX_RECIPIENTS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LastRunSummary = {
  state: string;
  scheduledFor: string;
  completedAt: string | null;
} | null;

export type ScheduleWithLastRun = {
  schedule: ReportScheduleRow;
  lastRun: LastRunSummary;
};

function normalizeRecipients(recipients: unknown): string[] {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one recipient is required",
    );
  }
  const cleaned = [
    ...new Set(recipients.map((r) => String(r).trim().toLowerCase())),
  ].filter(Boolean);
  if (cleaned.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one recipient is required",
    );
  }
  if (cleaned.length > MAX_RECIPIENTS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `At most ${MAX_RECIPIENTS} recipients per schedule`,
    );
  }
  for (const email of cleaned) {
    if (!EMAIL_PATTERN.test(email)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Invalid recipient email: ${email}`,
      );
    }
  }
  return cleaned;
}

function assertCadence(
  cadence: string,
): asserts cadence is ReportScheduleCadence {
  if (!(REPORT_SCHEDULE_CADENCES as readonly string[]).includes(cadence)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cadence must be one of: ${REPORT_SCHEDULE_CADENCES.join(", ")}`,
    );
  }
}

function assertReportType(type: string): asserts type is ReportType {
  if (!(REPORT_TYPES as readonly string[]).includes(type)) {
    throw new AppError("VALIDATION_ERROR", `Unknown report type: ${type}`);
  }
}

async function assertShareInProject(
  shareId: string,
  projectId: string,
): Promise<void> {
  const share = await SharingRepository.findShareById(shareId);
  if (!share) {
    throw new AppError("VALIDATION_ERROR", "Share not found");
  }
  const report = await ReportService.getReport({
    id: share.reportId,
    projectId,
  });
  if (!report) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Share does not belong to this project",
    );
  }
}

async function createSchedule(input: {
  projectId: string;
  organizationId: string;
  userId?: string;
  reportType: string;
  cadence: string;
  recipients: unknown;
  shareId?: string;
}): Promise<ReportScheduleRow> {
  assertReportType(input.reportType);
  assertCadence(input.cadence);
  const recipients = normalizeRecipients(input.recipients);
  if (input.shareId) {
    await assertShareInProject(input.shareId, input.projectId);
  }
  return ReportScheduleRepository.insertSchedule({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    organizationId: input.organizationId,
    reportType: input.reportType,
    cadence: input.cadence,
    recipients: JSON.stringify(recipients),
    shareId: input.shareId ?? null,
    active: true,
    nextDueAt: deriveNextDueAt(input.cadence),
    createdByUserId: input.userId ?? null,
  });
}

async function requireSchedule(
  projectId: string,
  id: string,
): Promise<ReportScheduleRow> {
  const row = await ReportScheduleRepository.getScheduleByIdForProject(
    id,
    projectId,
  );
  if (!row) throw new AppError("NOT_FOUND", "Report schedule not found");
  return row;
}

async function getSchedule(input: {
  projectId: string;
  organizationId: string;
  id: string;
}): Promise<ReportScheduleRow> {
  void input.organizationId;
  return requireSchedule(input.projectId, input.id);
}

async function updateSchedule(input: {
  projectId: string;
  organizationId: string;
  id: string;
  reportType?: string;
  cadence?: string;
  recipients?: unknown;
  shareId?: string | null;
}): Promise<ReportScheduleRow> {
  await requireSchedule(input.projectId, input.id);
  void input.organizationId;
  const patch: {
    reportType?: string;
    cadence?: string;
    recipients?: string;
    shareId?: string | null;
    nextDueAt?: string;
  } = {};
  if (input.reportType !== undefined) {
    assertReportType(input.reportType);
    patch.reportType = input.reportType;
  }
  if (input.cadence !== undefined) {
    assertCadence(input.cadence);
    patch.cadence = input.cadence;
    patch.nextDueAt = deriveNextDueAt(input.cadence);
  }
  if (input.recipients !== undefined) {
    patch.recipients = JSON.stringify(normalizeRecipients(input.recipients));
  }
  if (input.shareId !== undefined) {
    if (input.shareId !== null) {
      await assertShareInProject(input.shareId, input.projectId);
    }
    patch.shareId = input.shareId;
  }
  const updated = await ReportScheduleRepository.updateSchedule(
    input.id,
    input.projectId,
    patch,
  );
  if (!updated) throw new AppError("NOT_FOUND", "Report schedule not found");
  return updated;
}

async function pauseSchedule(input: {
  projectId: string;
  organizationId: string;
  id: string;
}): Promise<ReportScheduleRow> {
  const current = await requireSchedule(input.projectId, input.id);
  void input.organizationId;
  if (!current.active) return current;
  const updated = await ReportScheduleRepository.updateSchedule(
    input.id,
    input.projectId,
    {
      active: false,
      pausedAt: new Date().toISOString(),
      // nextDueAt freezes: pause is a user action, not a missed run.
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Report schedule not found");
  return updated;
}

async function resumeSchedule(input: {
  projectId: string;
  organizationId: string;
  id: string;
}): Promise<ReportScheduleRow> {
  const current = await requireSchedule(input.projectId, input.id);
  void input.organizationId;
  assertCadence(current.cadence);
  const updated = await ReportScheduleRepository.updateSchedule(
    input.id,
    input.projectId,
    {
      active: true,
      pausedAt: null,
      nextDueAt: deriveNextDueAt(current.cadence),
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Report schedule not found");
  return updated;
}

async function listSchedules(input: {
  projectId: string;
  organizationId: string;
}): Promise<ScheduleWithLastRun[]> {
  void input.organizationId;
  const schedules = await ReportScheduleRepository.listSchedulesByProject(
    input.projectId,
  );
  if (schedules.length === 0) return [];
  const latest = await ReportScheduleRepository.latestRunsByScheduleIds(
    schedules.map((s) => s.id),
  );
  const bySchedule = new Map<string, (typeof latest)[number]>();
  for (const run of latest) {
    if (!bySchedule.has(run.scheduleId)) bySchedule.set(run.scheduleId, run);
  }
  return schedules.map((schedule) => {
    const run = bySchedule.get(schedule.id);
    return {
      schedule,
      lastRun: run
        ? {
            state: run.state,
            scheduledFor: run.scheduledFor,
            completedAt: run.completedAt,
          }
        : null,
    };
  });
}

export const ReportScheduleService = {
  createSchedule,
  getSchedule,
  updateSchedule,
  pauseSchedule,
  resumeSchedule,
  listSchedules,
};
