import { z } from "zod";
import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import { backlinksItemSchema } from "@/server/lib/dataforseo/backlinks-schemas";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import type { BacklinkTotals } from "./backlinkChange";

/**
 * `lost_backlinks` (spec 008, C2a): dedicated lost-backlink opportunity
 * split out of the general backlink-change finding. Detection is a two-stage
 * process over STORED data first:
 *
 * 1. Compare the two newest stored backlink snapshots. Below the loss floor
 *    (or unknown totals) the detector completes silently — a valid
 *    observation of nothing notable, never a failure.
 * 2. Only when the floor is met, resolve lost-domain names through the
 *    cached backlinks-rows path (`is_lost` filter, single bounded page).
 *    Provider failure here is `InsufficientCoverageError` (no-trigger) —
 *    failure is never classified as loss (G9).
 *
 * Scan-time billing follows the scheduled-job precedent
 * (`scheduledRankChecks.ts`): a system billing customer scoped to the
 * project's organization. The metered client enforces budgets; a blocked
 * call surfaces as no-trigger, never as loss.
 */

/** Maximum lost domains named in frozen evidence (aggregate count covers the rest). */
export const LOST_DOMAIN_EVIDENCE_LIMIT = 10;

export type LostBacklinksInput = {
  domain: string;
  before: BacklinkTotals;
  after: BacklinkTotals;
  beforeCapturedAt: string;
  afterCapturedAt: string;
  lostDomains: string[];
  thresholds: Record<string, string | number | boolean>;
};

export function isLostBacklinksInput(
  value: unknown,
): value is LostBacklinksInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "domain" in value &&
    typeof value.domain === "string" &&
    "before" in value &&
    typeof value.before === "object" &&
    value.before !== null &&
    "after" in value &&
    typeof value.after === "object" &&
    value.after !== null &&
    "beforeCapturedAt" in value &&
    typeof value.beforeCapturedAt === "string" &&
    "afterCapturedAt" in value &&
    typeof value.afterCapturedAt === "string" &&
    "lostDomains" in value &&
    Array.isArray(value.lostDomains) &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

/**
 * Normalize one referring domain for evidence dedupe. Total function —
 * never throws on provider data. Lowercase, strip scheme/path, fold
 * leading `www.` only (all other subdomains stay distinct, matching the
 * analytical host policy); empty or non-string input yields null.
 */
export function normalizeLostDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutScheme = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const host = withoutScheme.split("/")[0]?.trim() ?? "";
  if (host === "") return null;
  return host.replace(/^www\./, "");
}

const lostRowsRouteSchema = z.object({
  items: z.array(backlinksItemSchema),
  totalCount: z.number().nullable(),
});

async function resolveLostDomainNames(
  domain: string,
  ctx: DetectorContext,
  projectId: string,
): Promise<string[]> {
  const response = await getSeoDataRouter().route<
    z.infer<typeof lostRowsRouteSchema>
  >(
    {
      dataType: "backlinks",
      domain,
      billingCustomer: {
        userId: "system",
        userEmail: "system@openseo.so",
        organizationId: ctx.organizationId,
        projectId,
      },
      creditFeature: "backlinks",
      constraints: {
        backlinkCall: "rows",
        filters: [["is_lost", "=", true]],
        limit: 100,
        orderBy: ["backlinks,desc"],
      },
    },
    lostRowsRouteSchema,
  );
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of response.data.items) {
    const name = normalizeLostDomain(item.domain_from);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (names.length >= LOST_DOMAIN_EVIDENCE_LIMIT) break;
    names.push(name);
  }
  return names;
}

type BacklinkSnapshotRow = Awaited<
  ReturnType<typeof BacklinkSnapshotRepository.getRecentForProject>
>[number];

function totalsOf(snap: BacklinkSnapshotRow): BacklinkTotals {
  return {
    backlinks: snap.backlinks,
    referringDomains: snap.referringDomains,
    brokenBacklinks: snap.brokenBacklinks,
    newBacklinks: snap.newBacklinks,
    lostBacklinks: snap.lostBacklinks,
    newReferringDomains: snap.newReferringDomains,
    lostReferringDomains: snap.lostReferringDomains,
  };
}

export async function fetchLostBacklinksInput(
  projectId: string,
  ctx: DetectorContext,
  nowMs: number = Date.now(),
): Promise<LostBacklinksInput> {
  const minSnapshots = thresholdNumber(ctx.thresholds, "minSnapshots");
  const freshnessDays = thresholdNumber(ctx.thresholds, "freshnessDays");
  const minReferringDomains = thresholdNumber(
    ctx.thresholds,
    "minReferringDomains",
  );
  const snapshots = await BacklinkSnapshotRepository.getRecentForProject(
    projectId,
    2,
  );
  if (snapshots.length < minSnapshots) {
    throw new InsufficientCoverageError(
      "lost_backlinks: fewer than 2 snapshots",
    );
  }
  const [after, before] = snapshots;
  if (!after || !before) {
    throw new InsufficientCoverageError(
      "lost_backlinks: fewer than 2 snapshots",
    );
  }
  const ageMs = nowMs - Date.parse(after.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs > freshnessDays * 86_400_000) {
    throw new InsufficientCoverageError(
      `lost_backlinks: newest snapshot older than ${freshnessDays}d`,
    );
  }
  const base = {
    domain: after.domain,
    before: totalsOf(before),
    after: totalsOf(after),
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    thresholds: {
      minSnapshots,
      freshnessDays,
      minReferringDomains,
    },
  };
  const lostRd = after.lostReferringDomains;
  // Below the floor (or unknown totals) is a valid observation of nothing
  // notable — return early WITHOUT the paid name-resolution leg.
  if (lostRd == null || lostRd < minReferringDomains) {
    return { ...base, lostDomains: [] };
  }
  let lostDomains: string[];
  try {
    lostDomains = await resolveLostDomainNames(after.domain, ctx, projectId);
  } catch {
    throw new InsufficientCoverageError(
      "lost_backlinks: lost-domain resolution failed",
    );
  }
  if (lostDomains.length === 0) {
    throw new InsufficientCoverageError(
      "lost_backlinks: no resolvable lost domains",
    );
  }
  return { ...base, lostDomains };
}

export function detectLostBacklinks(
  ctx: DetectorContext,
  input: LostBacklinksInput,
): FindingDraft[] {
  const floor = thresholdNumber(ctx.thresholds, "minReferringDomains");
  const lostRd = input.after.lostReferringDomains;
  // Unknown totals are not zero; unnamed losses are not evidence.
  if (lostRd == null || lostRd < floor) return [];
  if (input.lostDomains.length === 0) return [];
  const named = input.lostDomains.slice(0, LOST_DOMAIN_EVIDENCE_LIMIT);
  return [
    {
      entityKey: `backlinks:${input.domain}`,
      entity: { domain: input.domain, lostDomains: named.join(", ") },
      explanationFact:
        `Heuristic (two snapshots): ${lostRd} referring domains stopped linking to ` +
        `${input.domain} between ${input.beforeCapturedAt.slice(0, 10)} and ` +
        `${input.afterCapturedAt.slice(0, 10)}, including ${named.join(", ")}.`,
      evidence: {
        metrics: {
          lostReferringDomains: lostRd,
          namedLostDomains: named.length,
          lostBacklinks: input.after.lostBacklinks ?? 0,
          referringDomainsBefore: input.before.referringDomains ?? -1,
          referringDomainsAfter: input.after.referringDomains ?? -1,
        },
        periods: {
          from: input.beforeCapturedAt.slice(0, 10),
          to: input.afterCapturedAt.slice(0, 10),
        },
        sources: ["backlinks"],
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: ["two_point_heuristic"],
        confidenceInputs: { snapshotCount: 2, lostReferringDomains: lostRd },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: 50,
      coverageFlags: { twoSnapshots: true },
    },
  ];
}

export const lostBacklinksDetector: DetectorDef = {
  detectorKey: "lost_backlinks",
  version: 1,
  requiredSources: ["backlinks"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "backlinks", grains: ["snapshot"], minCoverageRatio: 1 },
  ],
  detect: (ctx, input) => {
    if (!isLostBacklinksInput(input)) {
      throw new Error("lost_backlinks: mistyped input");
    }
    return detectLostBacklinks(ctx, input);
  },
};
