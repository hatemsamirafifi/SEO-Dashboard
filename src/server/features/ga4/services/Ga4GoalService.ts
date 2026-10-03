import { AppError } from "@/server/lib/errors";
import {
  Ga4GoalRepository,
  type Ga4GoalRow,
} from "../repositories/Ga4GoalRepository";
import { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";

/** Maximum active goals per project (contracts/goals-api.md). Loud
 *  validation error at the cap — raising it is a deliberate product action. */
export const MAX_ACTIVE_GOALS_PER_PROJECT = 20;

export type GoalCoverage = {
  status: "complete" | "partial" | "none";
  coveredDates: number;
  totalDates: number;
  coveredThrough: string | null;
};

export type GoalConversions = {
  goal: Ga4GoalRow;
  conversions: number;
  coverage: GoalCoverage;
  /** Any stored event row for this goal's binding in the window at all
   *  (distinguishes no-data from measured zero downstream). */
  hasEventRows: boolean;
};

function trimmed(value: string): string {
  return value.trim();
}

async function requireActiveGoal(
  projectId: string,
  organizationId: string,
  goalId: string,
): Promise<Ga4GoalRow> {
  const goal = await Ga4GoalRepository.getByIdForProject(
    goalId,
    projectId,
    organizationId,
  );
  if (!goal || goal.archivedAt) {
    throw new AppError(
      "NOT_FOUND",
      "Goal not found (unknown, archived, or another project)",
    );
  }
  return goal;
}

function windowDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new AppError("VALIDATION_ERROR", "Invalid goal conversion window");
  }
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

async function createGoal(input: {
  projectId: string;
  organizationId: string;
  name: string;
  eventName: string;
  matchKeyEventOnly?: boolean;
}): Promise<Ga4GoalRow> {
  const name = trimmed(input.name);
  const eventName = trimmed(input.eventName);
  if (!name || !eventName) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Goal name and event name must not be blank",
    );
  }
  const activeCount = await Ga4GoalRepository.countActiveByProject(
    input.projectId,
    input.organizationId,
  );
  if (activeCount >= MAX_ACTIVE_GOALS_PER_PROJECT) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A project may have at most ${MAX_ACTIVE_GOALS_PER_PROJECT} active goals`,
    );
  }
  const existing = await Ga4GoalRepository.findActiveByName(
    input.projectId,
    input.organizationId,
    name,
  );
  if (existing) {
    throw new AppError(
      "VALIDATION_ERROR",
      "An active goal with this name already exists",
    );
  }
  return Ga4GoalRepository.create({
    projectId: input.projectId,
    organizationId: input.organizationId,
    name,
    eventName,
    matchKeyEventOnly: input.matchKeyEventOnly ?? false,
  });
}

async function listGoals(input: {
  projectId: string;
  organizationId: string;
  includeArchived?: boolean;
}): Promise<Ga4GoalRow[]> {
  return Ga4GoalRepository.listByProject(
    input.projectId,
    input.organizationId,
    input.includeArchived ?? false,
  );
}

async function getGoal(input: {
  projectId: string;
  organizationId: string;
  id: string;
}): Promise<Ga4GoalRow | null> {
  return Ga4GoalRepository.getByIdForProject(
    input.id,
    input.projectId,
    input.organizationId,
  );
}

async function updateGoal(input: {
  projectId: string;
  organizationId: string;
  id: string;
  name?: string;
  eventName?: string;
  matchKeyEventOnly?: boolean;
}): Promise<Ga4GoalRow> {
  const goal = await Ga4GoalRepository.getByIdForProject(
    input.id,
    input.projectId,
    input.organizationId,
  );
  if (!goal) {
    throw new AppError("NOT_FOUND", "Goal not found");
  }
  if (goal.archivedAt) {
    throw new AppError(
      "VALIDATION_ERROR",
      "An archived goal is read-only; historical evidence stays frozen",
    );
  }
  const patch: {
    name?: string;
    eventName?: string;
    matchKeyEventOnly?: boolean;
  } = {};
  if (input.name !== undefined) {
    const name = trimmed(input.name);
    if (!name) {
      throw new AppError("VALIDATION_ERROR", "Goal name must not be blank");
    }
    if (name !== goal.name) {
      const clash = await Ga4GoalRepository.findActiveByName(
        input.projectId,
        input.organizationId,
        name,
      );
      if (clash && clash.id !== goal.id) {
        throw new AppError(
          "VALIDATION_ERROR",
          "An active goal with this name already exists",
        );
      }
    }
    patch.name = name;
  }
  if (input.eventName !== undefined) {
    const eventName = trimmed(input.eventName);
    if (!eventName) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Goal event name must not be blank",
      );
    }
    patch.eventName = eventName;
  }
  if (input.matchKeyEventOnly !== undefined) {
    patch.matchKeyEventOnly = input.matchKeyEventOnly;
  }
  const updated = await Ga4GoalRepository.updateById(goal.id, patch);
  if (!updated) throw new AppError("NOT_FOUND", "Goal not found");
  return updated;
}

async function archiveGoal(input: {
  projectId: string;
  organizationId: string;
  id: string;
}): Promise<Ga4GoalRow> {
  const goal = await Ga4GoalRepository.getByIdForProject(
    input.id,
    input.projectId,
    input.organizationId,
  );
  if (!goal) {
    throw new AppError("NOT_FOUND", "Goal not found");
  }
  if (goal.archivedAt) return goal;
  await Ga4GoalRepository.archiveById(goal.id, new Date().toISOString());
  const archived = await Ga4GoalRepository.getByIdForProject(
    input.id,
    input.projectId,
    input.organizationId,
  );
  if (!archived) throw new AppError("NOT_FOUND", "Goal not found");
  return archived;
}

async function getGoalConversions(input: {
  projectId: string;
  organizationId: string;
  propertyId: string;
  goalId: string;
  from: string;
  to: string;
}): Promise<GoalConversions> {
  const goal = await requireActiveGoal(
    input.projectId,
    input.organizationId,
    input.goalId,
  );
  const read = await Ga4SyncRepository.getGoalConversions({
    projectId: input.projectId,
    propertyId: input.propertyId,
    eventName: goal.eventName,
    matchKeyEventOnly: goal.matchKeyEventOnly,
    from: input.from,
    to: input.to,
  });
  const totalDates = windowDays(input.from, input.to);
  const covered = read.coveredDates.length;
  return {
    goal,
    conversions: read.conversions,
    coverage: {
      status:
        covered >= totalDates ? "complete" : covered > 0 ? "partial" : "none",
      coveredDates: covered,
      totalDates,
      coveredThrough: read.coveredThrough,
    },
    hasEventRows: read.hasEventRows,
  };
}

export const Ga4GoalService = {
  createGoal,
  listGoals,
  getGoal,
  updateGoal,
  archiveGoal,
  getGoalConversions,
};
