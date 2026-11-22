// oxlint-disable typescript-eslint/no-extraneous-class
import { type SeoActionStatus } from "@/shared/samSeoAnalyst";
import {
  SeoActionRepository,
  type SaveActionItemInput,
} from "./SeoActionRepository";

export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly currentStatus: string,
    public readonly targetStatus: string,
    message?: string,
  ) {
    super(
      message ??
        `Invalid status transition from "${currentStatus}" to "${targetStatus}".`,
    );
    this.name = "InvalidStatusTransitionError";
  }
}

const ALLOWED_TRANSITIONS: Record<SeoActionStatus, SeoActionStatus[]> = {
  proposed: ["accepted", "dismissed"],
  accepted: ["in_progress", "blocked", "dismissed"],
  in_progress: ["completed", "blocked", "dismissed", "accepted"],
  blocked: ["in_progress", "accepted", "dismissed"],
  completed: ["verification_pending", "reopened"],
  verification_pending: ["verified", "reopened", "completed"],
  verified: ["reopened"],
  dismissed: ["reopened"],
  reopened: ["in_progress", "accepted"],
};

export class SeoActionService {
  /**
   * Validate whether a status transition is permitted according to the lifecycle model.
   */
  static isValidTransition(
    currentStatus: SeoActionStatus,
    targetStatus: SeoActionStatus,
  ): boolean {
    if (currentStatus === targetStatus) return true;
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    return allowed ? allowed.includes(targetStatus) : false;
  }

  /**
   * Save a recommendation into an action item explicitly.
   */
  static async saveRecommendation(input: SaveActionItemInput) {
    return SeoActionRepository.saveActionItem(input);
  }

  /**
   * Transition an action item to a new status with an authorized actor and audit trail.
   */
  static async transitionStatus(params: {
    itemId: string;
    projectId: string;
    organizationId: string;
    targetStatus: SeoActionStatus;
    actor: string;
    notes?: string | null;
  }) {
    const actor = params.actor?.trim();
    if (!actor || actor === "sam_agent") {
      throw new Error(
        "Authorized user actor is required to transition action item status.",
      );
    }

    const item = await SeoActionRepository.getItemById(
      params.itemId,
      params.projectId,
      params.organizationId,
    );
    if (!item) {
      throw new Error(`Action item ${params.itemId} not found.`);
    }

    const currentStatus = item.status as SeoActionStatus;
    const targetStatus = params.targetStatus;

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new InvalidStatusTransitionError(
        currentStatus,
        targetStatus,
        `Cannot move task from "${currentStatus}" to "${targetStatus}". Permitted next states: ${(ALLOWED_TRANSITIONS[currentStatus] ?? []).join(", ") || "none"}`,
      );
    }

    const updates: Parameters<typeof SeoActionRepository.updateItem>[3] = {
      status: targetStatus,
    };

    if (targetStatus === "completed" && !item.completedAt) {
      updates.completedAt = new Date().toISOString();
    } else if (targetStatus === "reopened") {
      updates.completedAt = null;
      updates.verifiedAt = null;
      updates.verificationOutcome = null;
      updates.verificationNotes = null;
    }

    const updated = await SeoActionRepository.updateItem(
      params.itemId,
      params.projectId,
      params.organizationId,
      updates,
    );

    // Record append-only event
    await SeoActionRepository.addEvent({
      actionItemId: params.itemId,
      actor,
      previousStatus: currentStatus,
      newStatus: targetStatus,
      notes: params.notes ?? null,
    });

    return updated;
  }

  /**
   * Add implementation note without changing status.
   */
  static async addNote(params: {
    itemId: string;
    projectId: string;
    organizationId: string;
    actor: string;
    notes: string;
  }) {
    const actor = params.actor?.trim();
    if (!actor || actor === "sam_agent") {
      throw new Error(
        "Authorized user actor is required to add an action item note.",
      );
    }

    const item = await SeoActionRepository.getItemById(
      params.itemId,
      params.projectId,
      params.organizationId,
    );
    if (!item) {
      throw new Error(`Action item ${params.itemId} not found.`);
    }

    return SeoActionRepository.addEvent({
      actionItemId: params.itemId,
      actor,
      previousStatus: item.status,
      newStatus: item.status,
      notes: params.notes,
    });
  }

  /**
   * Update task details (due date, description, etc.).
   */
  static async updateDetails(params: {
    itemId: string;
    projectId: string;
    organizationId: string;
    dueDate?: string | null;
    description?: string | null;
    actor: string;
  }) {
    const item = await SeoActionRepository.getItemById(
      params.itemId,
      params.projectId,
      params.organizationId,
    );
    if (!item) {
      throw new Error(`Action item ${params.itemId} not found.`);
    }

    return SeoActionRepository.updateItem(
      params.itemId,
      params.projectId,
      params.organizationId,
      {
        dueDate: params.dueDate !== undefined ? params.dueDate : item.dueDate,
        description:
          params.description !== undefined
            ? params.description
            : item.description,
      },
    );
  }
}
