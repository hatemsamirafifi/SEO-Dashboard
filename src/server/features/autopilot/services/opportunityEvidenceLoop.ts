import { stableHash } from "@/shared/intelligence";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
import { rankedIdsOf } from "./autopilotWorkflowContent";
import type { AutopilotRepository } from "../repositories/AutopilotRepository";

type CompletedStepRow = Awaited<
  ReturnType<typeof AutopilotRepository.listStepsByAttempt>
>[number];

export type CompletionEvidenceResult = {
  /** Occurrences that received an event this call. */
  occurrences: number;
  /** Events appended (one per occurrence; idempotent replays append none). */
  appended: number;
};

/**
 * Spec 021 (FR-007): close the loop between autopilot and the action center.
 * After a run completes, every opportunity occurrence a step referenced gets
 * one `completion_evidence` event carrying the run/attempt ids and the
 * referencing steps — so the owner can see, on the opportunity itself, that
 * automation acted on it and with what outcome.
 *
 * Idempotent: the event key is content-derived per (occurrence, run), so a
 * resumed or retried drive replays nothing. Isolated: a failing append (for
 * example a deleted occurrence) is logged per occurrence and never changes
 * the run outcome.
 */
export async function appendCompletionEvidence(input: {
  runId: string;
  attemptId: string;
  projectId: string;
  workflowType: string;
  steps: CompletedStepRow[];
}): Promise<CompletionEvidenceResult> {
  // Which occurrences did each step reference? A step's evidence carries the
  // ranked ids of the opportunities it consumed (rankedIdsOf).
  const byOccurrence = new Map<string, Array<{ seq: number; kind: string }>>();
  for (const step of input.steps) {
    if (!step.evidenceJson) continue;
    let evidence: unknown;
    try {
      evidence = JSON.parse(step.evidenceJson);
    } catch {
      continue;
    }
    for (const occurrenceId of rankedIdsOf(evidence)) {
      const bucket = byOccurrence.get(occurrenceId) ?? [];
      bucket.push({ seq: step.seq, kind: step.kind });
      byOccurrence.set(occurrenceId, bucket);
    }
  }

  let appended = 0;
  for (const [occurrenceId, steps] of byOccurrence) {
    try {
      const inserted = await OpportunityRepository.insertEventIgnoreConflict({
        id: crypto.randomUUID(),
        occurrenceId,
        type: "completion_evidence",
        eventKey: await stableHash(
          `${occurrenceId}|completion_evidence|${input.runId}`,
        ),
        scanId: null,
        payloadJson: JSON.stringify({
          runId: input.runId,
          attemptId: input.attemptId,
          projectId: input.projectId,
          workflowType: input.workflowType,
          outcome: "completed",
          steps,
        }),
      });
      if (inserted) appended += 1;
    } catch (error) {
      console.error(
        `[autopilot:${input.runId}] completion evidence append failed for ${occurrenceId}:`,
        error,
      );
    }
  }
  return { occurrences: byOccurrence.size, appended };
}
