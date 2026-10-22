import { waitUntil } from "cloudflare:workers";
import { captureServerEvent } from "@/server/lib/posthog";
import type { DetectionSourceState } from "./SourceTokens";

/**
 * Scan-time helpers for the detection stage: source-state comparison,
 * short hashes for the scan logs, and the analytics event capture used by
 * the retry and terminal paths. Split out of FindingService so that file
 * stays inside the repo max-lines gate.
 */

export type DetectionAttemptMeta = {
  attempt: number;
  beforeHash8: string;
  afterHash8: string | null;
  changedSources: string[];
  activeReasons: string[];
};

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function captureIntelligenceEvent(input: {
  event: string;
  projectId: string;
  organizationId: string;
  actorUserId?: string;
  properties?: Record<string, unknown>;
}): void {
  waitUntil(
    captureServerEvent({
      distinctId: input.actorUserId ?? input.organizationId,
      event: input.event,
      organizationId: input.organizationId,
      properties: { project_id: input.projectId, ...input.properties },
    }),
  );
}

export function versionsEqual(
  first: DetectionSourceState,
  second: DetectionSourceState,
): boolean {
  const keys = ["gsc", "ga4", "rank", "audit", "backlinks"] as const;
  if (first.thresholdVersion !== second.thresholdVersion) return false;
  if (first.sourceSet.join(",") !== second.sourceSet.join(",")) return false;
  // Order-invariant without sorting: same key set, same per-key values.
  const firstKeys = Object.keys(first.detectorVersions);
  if (firstKeys.length !== Object.keys(second.detectorVersions).length) {
    return false;
  }
  if (
    !firstKeys.every(
      (key) => first.detectorVersions[key] === second.detectorVersions[key],
    )
  ) {
    return false;
  }
  return keys.every((key) => first.versions[key] === second.versions[key]);
}

export function changedSources(
  before: DetectionSourceState,
  after: DetectionSourceState,
): string[] {
  const changed: string[] = [];
  const keys = ["gsc", "ga4", "rank", "audit", "backlinks"] as const;
  for (const key of keys) {
    if (before.versions[key] !== after.versions[key]) changed.push(key);
  }
  if (before.sourceSet.join(",") !== after.sourceSet.join(",")) {
    changed.push("sourceSet");
  }
  return changed;
}
