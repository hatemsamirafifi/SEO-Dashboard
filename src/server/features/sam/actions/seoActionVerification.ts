// oxlint-disable typescript-eslint/no-extraneous-class
import {
  type SeoActionStatus,
  type SeoVerificationOutcome,
} from "@/shared/samSeoAnalyst";
import { SeoActionRepository } from "./SeoActionRepository";
import { InvalidStatusTransitionError } from "./SeoActionService";
import {
  type ActionItem,
  type VerificationCheckResult,
  evaluatePositionOutcome,
  parseBaselinePosition,
  verifyViaRankTracker,
  verifyViaSearchConsole,
  verifyViaSiteAudit,
} from "./seoActionVerificationChecks";

export { evaluatePositionOutcome, parseBaselinePosition };

export interface VerificationResult {
  outcome: SeoVerificationOutcome;
  evidenceSufficient: boolean;
  awaitingNewerData: boolean;
  verificationAttempted: boolean;
  status: SeoActionStatus;
  notes: string;
  metricName: string;
  baselineValue: string | null;
  currentValue: string | null;
  baselineDate: string | null;
  observationDate: string | null;
  item: ActionItem;
}

export interface VerificationEvaluationResult {
  outcome: SeoVerificationOutcome;
  evidenceSufficient: boolean;
  awaitingNewerData: boolean;
  recommendedStatus: SeoActionStatus;
  notes: string;
  metricName: string;
  baselineValue: string | null;
  currentValue: string | null;
  baselineDate: string | null;
  observationDate: string | null;
  item: ActionItem;
}

export function isSufficientVerificationOutcome(
  outcome: SeoVerificationOutcome,
): boolean {
  return outcome !== "insufficient_data";
}

const VERIFIABLE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "verification_pending",
]);

async function evaluateItemAgainstLocalEvidence(
  item: ActionItem,
  projectId: string,
): Promise<{ check: VerificationCheckResult; metricName: string }> {
  const evidenceRows = await SeoActionRepository.getEvidenceForItem(item.id);

  const hasRankTrackerProvenance = evidenceRows.some(
    (ev) => ev.source === "get_rank_tracker",
  );
  const hasGscProvenance = evidenceRows.some(
    (ev) => ev.source === "get_search_console_performance",
  );

  let check: VerificationCheckResult = {
    outcome: "insufficient_data",
    notes: "Insufficient new comparable observation data to evaluate outcome.",
    currentValue: null,
    observationDate: null,
  };

  if (item.category === "ranking_drop" || hasRankTrackerProvenance) {
    check = await verifyViaRankTracker(item, projectId);
  } else if (item.category === "keyword_opportunity" && hasGscProvenance) {
    check = await verifyViaSearchConsole(item, projectId);
  } else if (item.category === "keyword_opportunity") {
    check = {
      outcome: "insufficient_data",
      notes:
        "Baseline provenance is unclear or not comparable; awaiting compatible Search Console or Rank Tracker evidence.",
      currentValue: null,
      observationDate: null,
    };
  } else if (item.category === "content_technical") {
    check = await verifyViaSiteAudit(item, evidenceRows, projectId);
  }

  return {
    check,
    metricName: item.validationMetric || "unknown",
  };
}

export class SeoActionVerificationEngine {
  /**
   * Strictly read-only evaluation of an action item against compatible local
   * OpenSEO evidence. Never mutates task status or writes audit events.
   * Safe for agent/tool inspection without workflow authorization.
   */
  static async evaluateItem(params: {
    itemId: string;
    projectId: string;
    organizationId: string;
  }): Promise<VerificationEvaluationResult> {
    const item = await SeoActionRepository.getItemById(
      params.itemId,
      params.projectId,
      params.organizationId,
    );
    if (!item) {
      throw new Error(`Action item ${params.itemId} not found.`);
    }

    const { check, metricName } = await evaluateItemAgainstLocalEvidence(
      item,
      params.projectId,
    );
    const evidenceSufficient = isSufficientVerificationOutcome(check.outcome);

    return {
      outcome: check.outcome,
      evidenceSufficient,
      awaitingNewerData: !evidenceSufficient,
      recommendedStatus: evidenceSufficient
        ? "verified"
        : "verification_pending",
      notes: check.notes,
      metricName,
      baselineValue: item.baselineValue,
      currentValue: check.currentValue,
      baselineDate: item.baselineObservationDate,
      observationDate: check.observationDate,
      item,
    };
  }

  /**
   * Verify an action item against compatible local OpenSEO evidence and record
   * the verification attempt in persistent storage.
   *
   * Rules:
   * - Strictly read-only against local SQLite / D1 evidence sources (no paid APIs).
   * - Requires an authorized user actor (never anonymous or autonomous agent).
   * - Only items in `completed` or `verification_pending` may be verified.
   * - `insufficient_data` NEVER transitions a task to `verified`; it keeps the
   *   task in `verification_pending` with `verifiedAt: null` until sufficient
   *   comparable evidence exists.
   * - Preserves existing append-only audit history.
   */
  static async verifyItem(params: {
    itemId: string;
    projectId: string;
    organizationId: string;
    actor: string;
  }): Promise<VerificationResult> {
    const actor = params.actor?.trim();
    if (!actor || actor === "sam_agent") {
      throw new Error(
        "Authorized user actor is required to record verification and update workflow status.",
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

    if (!VERIFIABLE_STATUSES.has(item.status)) {
      throw new InvalidStatusTransitionError(
        item.status,
        "verification_pending",
        `Cannot verify task while status is "${item.status}". Mark implementation as completed first.`,
      );
    }

    const { check, metricName } = await evaluateItemAgainstLocalEvidence(
      item,
      params.projectId,
    );
    const evidenceSufficient = isSufficientVerificationOutcome(check.outcome);
    const nextStatus: SeoActionStatus = evidenceSufficient
      ? "verified"
      : "verification_pending";

    const now = new Date().toISOString();
    const updated = await SeoActionRepository.updateItem(
      params.itemId,
      params.projectId,
      params.organizationId,
      {
        status: nextStatus,
        verificationOutcome: check.outcome,
        verificationNotes: check.notes,
        verifiedAt: evidenceSufficient ? now : null,
      },
    );

    const eventNotes = evidenceSufficient
      ? `Verified outcome: ${check.outcome} (${check.notes})`
      : `Verification attempted — insufficient comparable evidence (${check.notes})`;

    await SeoActionRepository.addEvent({
      actionItemId: params.itemId,
      actor,
      previousStatus: item.status,
      newStatus: nextStatus,
      notes: eventNotes,
      metadata: {
        verificationAttempted: true,
        evidenceSufficient,
        awaitingNewerData: !evidenceSufficient,
        outcome: check.outcome,
        metricName,
        baselineValue: item.baselineValue,
        currentValue: check.currentValue,
        baselineDate: item.baselineObservationDate,
        observationDate: check.observationDate,
        attemptedAt: now,
      },
    });

    return {
      outcome: check.outcome,
      evidenceSufficient,
      awaitingNewerData: !evidenceSufficient,
      verificationAttempted: true,
      status: nextStatus,
      notes: check.notes,
      metricName,
      baselineValue: item.baselineValue,
      currentValue: check.currentValue,
      baselineDate: item.baselineObservationDate,
      observationDate: check.observationDate,
      item: updated ?? item,
    };
  }
}
