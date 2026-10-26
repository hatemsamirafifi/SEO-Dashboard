import { compareOpportunities } from "@/shared/intelligence";
import {
  OpportunityRepository,
  type OpportunityRow,
} from "../repositories/OpportunityRepository";
import { recentWindowSince, toComparable } from "./OpportunityService";

/**
 * Next actions (spec 021): the unified action-center read over stored
 * opportunities — no second engine, no recomputed heuristics. "Reopened" is
 * the stored recurrence chain, nothing else; every view states honest
 * pre-cap counts.
 */

/** Reasoned priors; request parameters may override both. */
const NEXT_ACTIONS_RECENT_DAYS = 7;
const NEXT_ACTIONS_VIEW_LIMIT = 8;

type NextActionsSnapshot = {
  /** Top open items in the shared canonical order. */
  critical: OpportunityRow[];
  /** Rows first detected inside the recent window, newest first. */
  recent: OpportunityRow[];
  /** Completed rows, most recently completed first. */
  completed: OpportunityRow[];
  /** Occurrences with a stored recurrence chain, newest first. */
  reopened: OpportunityRow[];
  /** Matching rows per view before the display cap (honest counts). */
  counts: {
    critical: number;
    recent: number;
    completed: number;
    reopened: number;
  };
  /** The applied inclusive lower bound on firstDetectedAt (ISO). */
  recentSince: string;
};

/** Newest-first with a stable id tiebreak (NFR-002). */
function byNewestDesc(
  keyOf: (row: OpportunityRow) => string,
): (a: OpportunityRow, b: OpportunityRow) => number {
  return (a, b) => {
    const [keyA, keyB] = [keyOf(a), keyOf(b)];
    if (keyA === keyB) return a.id < b.id ? -1 : 1;
    return keyA < keyB ? 1 : -1;
  };
}

/**
 * The four dashboard views, derived from one stored read of the project's
 * opportunities (the list service reads the same rows).
 */
export async function getNextActions(input: {
  projectId: string;
  recentDays?: number;
  limit?: number;
  now?: number;
}): Promise<NextActionsSnapshot> {
  const recentDays = input.recentDays ?? NEXT_ACTIONS_RECENT_DAYS;
  const limit = input.limit ?? NEXT_ACTIONS_VIEW_LIMIT;
  const recentSince = recentWindowSince(recentDays, input.now);

  const rows = await OpportunityRepository.listByProject(input.projectId);
  const openRows = rows.filter(
    (row) => row.status === "open" || row.status === "in_progress",
  );
  const critical = [...openRows]
    .toSorted((a, b) => compareOpportunities(toComparable(a), toComparable(b)))
    .slice(0, limit);

  const recentRows = rows.filter((row) => row.firstDetectedAt >= recentSince);
  const recent = [...recentRows]
    .toSorted(byNewestDesc((row) => row.firstDetectedAt))
    .slice(0, limit);

  const completedRows = rows.filter((row) => row.status === "completed");
  const completed = [...completedRows]
    .toSorted(byNewestDesc((row) => row.completedAt ?? row.lastDetectedAt))
    .slice(0, limit);

  const reopenedRows = rows.filter((row) => row.recurrenceOfId !== null);
  const reopened = [...reopenedRows]
    .toSorted(byNewestDesc((row) => row.lastDetectedAt))
    .slice(0, limit);

  return {
    critical,
    recent,
    completed,
    reopened,
    counts: {
      critical: openRows.length,
      recent: recentRows.length,
      completed: completedRows.length,
      reopened: reopenedRows.length,
    },
    recentSince,
  };
}
