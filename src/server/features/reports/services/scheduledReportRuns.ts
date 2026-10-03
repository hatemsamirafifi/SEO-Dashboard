import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ReportService } from "./ReportService";
import { ReportScheduleRepository } from "../repositories/ReportScheduleRepository";
import { ScheduleRunService } from "./ScheduleRunService";
import { advanceSchedule, reportPeriodFor } from "./cadence";
import { REPORT_TYPES, type ReportScheduleCadence } from "@/shared/reports";

export type ScheduledReportRunSummary = {
  checked: number;
  generated: number;
  skipped: number;
  failed: number;
};

function isCadence(value: string): value is ReportScheduleCadence {
  return value === "weekly" || value === "monthly";
}

/**
 * Cron pass for scheduled reports (spec 012, US2 — T022). Follows the
 * `scheduledGa4Sync` shape exactly: list due → per-schedule try/catch with
 * honest skip logging. Exactly-once comes from the ledger (claim-before-do);
 * this function never generates without owning a claim.
 *
 * US2 ends runs in `delivering` (report linked, send step pending — US3 adds
 * the send). Generation failures record `failed (generation)` and skip
 * delivery entirely.
 */
export async function runScheduledReportRuns(
  now: Date = new Date(),
): Promise<ScheduledReportRunSummary> {
  const summary: ScheduledReportRunSummary = {
    checked: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
  };
  let due: Awaited<
    ReturnType<typeof ReportScheduleRepository.listDueSchedules>
  >;
  try {
    due = await ReportScheduleRepository.listDueSchedules(now.toISOString());
  } catch (err) {
    console.error("[cron:reports] Failed to list due schedules:", err);
    return summary;
  }
  for (const schedule of due) {
    summary.checked += 1;
    try {
      const outcome = await processDueSchedule(schedule, now);
      if (outcome === "generated") summary.generated += 1;
      else if (outcome === "failed") summary.failed += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[cron:reports] Uncaught error processing schedule ${schedule.id}:`,
        err,
      );
    }
  }
  if (summary.checked > 0) {
    console.log(
      `[cron:reports] Pass complete: ${summary.checked} checked, ` +
        `${summary.generated} generated, ${summary.skipped} skipped, ` +
        `${summary.failed} failed`,
    );
  }
  return summary;
}

async function processDueSchedule(
  schedule: Awaited<
    ReturnType<typeof ReportScheduleRepository.listDueSchedules>
  >[number],
  now: Date,
): Promise<"generated" | "skipped" | "failed"> {
  if (!isCadence(schedule.cadence)) {
    console.error(
      `[cron:reports] Schedule ${schedule.id} has unknown cadence ${schedule.cadence}; skipping`,
    );
    return "skipped";
  }
  const reportType =
    REPORT_TYPES.find((t) => t === schedule.reportType) ?? null;
  if (!reportType) {
    console.error(
      `[cron:reports] Schedule ${schedule.id} has unknown report type ${schedule.reportType}; skipping`,
    );
    return "skipped";
  }
  const { runFor, nextDueAt } = advanceSchedule(
    schedule.cadence,
    new Date(schedule.nextDueAt),
    now,
  );
  const claim = await ScheduleRunService.claimRun({
    scheduleId: schedule.id,
    scheduledFor: runFor,
  });
  if (claim.outcome !== "owned") {
    // A conflicted row that already links a report finished generating
    // (terminal, or a crash between generation and advance): the period is
    // done, so advancing cannot duplicate anything. Otherwise another tick
    // owns it — hands off.
    const periodDone =
      claim.outcome === "already-terminal" || claim.run.reportId !== null;
    if (periodDone) {
      await ReportScheduleRepository.updateSchedule(
        schedule.id,
        schedule.projectId,
        { nextDueAt, lastRunAt: now.toISOString() },
      );
      console.log(
        `[cron:reports] Schedule ${schedule.id} for ${runFor}: period already generated; advanced past it`,
      );
    } else {
      console.log(
        `[cron:reports] Schedule ${schedule.id} for ${runFor}: claim ${claim.outcome}; skipping`,
      );
    }
    return "skipped";
  }
  await ScheduleRunService.transitionRun({
    runId: claim.run.id,
    to: "generating",
  });
  // nextDueAt advances ONLY on success. A failed generation leaves the
  // schedule due so the next tick retries the same period on the same row;
  // a crash after generation leaves a delivering row the next tick skips via
  // claim-conflict (never a duplicate) until it goes stale and reclaims.
  try {
    const project = await ProjectRepository.getProjectById(schedule.projectId);
    const period = reportPeriodFor(schedule.cadence, runFor);
    const report = await ReportService.generateReport({
      projectId: schedule.projectId,
      organizationId: schedule.organizationId,
      domain: project?.domain ?? null,
      type: reportType,
      period,
    });
    await ScheduleRunService.transitionRun({
      runId: claim.run.id,
      to: "delivering",
      reportId: report.id,
    });
    await ReportScheduleRepository.updateSchedule(
      schedule.id,
      schedule.projectId,
      { nextDueAt, lastRunAt: now.toISOString() },
    );
    console.log(
      `[cron:reports] Schedule ${schedule.id} for ${runFor}: generated report ${report.id}`,
    );
    return "generated";
  } catch (err) {
    await ScheduleRunService.transitionRun({
      runId: claim.run.id,
      to: "failed",
      failureClass: "generation",
    });
    await ReportScheduleRepository.updateSchedule(
      schedule.id,
      schedule.projectId,
      {
        lastRunAt: now.toISOString(),
      },
    );
    console.error(
      `[cron:reports] Schedule ${schedule.id} for ${runFor}: generation failed:`,
      err,
    );
    return "failed";
  }
}
