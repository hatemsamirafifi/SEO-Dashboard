import type { ReportScheduleCadence } from "@/shared/reports";

const DAY_MS = 24 * 60 * 60 * 1000;

function atMidnightUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function mondayOf(date: Date): Date {
  const day = atMidnightUtc(date);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Shift so Monday = 0.
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function periodStart(cadence: ReportScheduleCadence, date: Date): Date {
  return cadence === "weekly" ? mondayOf(date) : firstOfMonth(date);
}

function addPeriod(cadence: ReportScheduleCadence, boundary: Date): Date {
  if (cadence === "weekly") {
    return new Date(boundary.getTime() + 7 * DAY_MS);
  }
  return new Date(
    Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth() + 1, 1),
  );
}

function isoDateOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Next due instant strictly after `from`: next Monday / 1st-of-next-month
 *  00:00 UTC. Replaces the T011 inline stub (identical happy-path rule). */
export function deriveNextDueAt(
  cadence: ReportScheduleCadence,
  from: Date = new Date(),
): string {
  const candidate = addPeriod(cadence, periodStart(cadence, from));
  if (candidate.getTime() <= from.getTime()) {
    return addPeriod(cadence, candidate).toISOString();
  }
  return candidate.toISOString();
}

/** Ledger period key for an instant: its week's Monday / its month's 1st
 *  (`YYYY-MM-DD`). Lexicographically sortable on both dialects. */
export function scheduledForOf(
  cadence: ReportScheduleCadence,
  date: Date,
): string {
  return isoDateOf(periodStart(cadence, date));
}

/**
 * Report period for a due date: the completed span the report covers.
 * Weekly due Monday M covers the previous Mon–Sun (M-7d … M-1d); monthly due
 * the 1st covers the whole previous month. Deterministic and explainable —
 * a Monday-morning report always describes last week, never a partial one.
 */
export function reportPeriodFor(
  cadence: ReportScheduleCadence,
  scheduledFor: string,
): { from: string; to: string } {
  const due = new Date(`${scheduledFor}T00:00:00Z`);
  if (cadence === "weekly") {
    return {
      from: isoDateOf(new Date(due.getTime() - 7 * DAY_MS)),
      to: isoDateOf(new Date(due.getTime() - DAY_MS)),
    };
  }
  const first = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1));
  const lastPrev = new Date(first.getTime() - DAY_MS);
  return {
    from: isoDateOf(
      new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1)),
    ),
    to: isoDateOf(lastPrev),
  };
}

/**
 * Advance a schedule whose `lastDue` was due. Late runs target the passed
 * date (never skip to the next one); missed-multi-period yields exactly one
 * catch-up — the most recent missed period — then advance. A future
 * `lastDue` is a defensive no-op.
 */
export function advanceSchedule(
  cadence: ReportScheduleCadence,
  lastDue: Date,
  now: Date = new Date(),
): { runFor: string; nextDueAt: string } {
  if (lastDue.getTime() > now.getTime()) {
    return {
      runFor: scheduledForOf(cadence, lastDue),
      nextDueAt: lastDue.toISOString(),
    };
  }
  const boundary = periodStart(cadence, now);
  return {
    runFor: isoDateOf(boundary),
    nextDueAt: addPeriod(cadence, boundary).toISOString(),
  };
}
