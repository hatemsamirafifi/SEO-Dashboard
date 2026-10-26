import { getProjectDomain } from "@/server/lib/seo-data/competitor-snapshot-repository";
import { AiSearchObservationRepository } from "@/server/features/ai-search/repositories/AiSearchObservationRepository";
import { canonicalProjectDomain } from "@/shared/intelligence";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * AI citation gaps (spec 020). Reads only the recorded Prompt Explorer
 * observations (spec 020 slice A) — never a paid provider (FR-012). The
 * detector separates citations (pages the model cited, stored rows) from
 * mentions (a brand named in answer text, never persisted) by construction:
 * only stored citation rows are analyzed (FR-007).
 *
 * Three finding families (FR-008), each stating the observed counts and the
 * observation basis (FR-009):
 * - cited_without_us: a run that cited pages, none of them this project's.
 * - frequent_third_party: a third-party domain cited in enough runs.
 * - no_cited_sources: a run that cited nothing at all.
 *
 * Every finding below the small-sample floor carries the small-sample label
 * and a lowered confidence (FR-009, SC-004).
 */

export type AiCitationGapCitationRow = {
  url: string;
  domain: string;
  title: string | null;
  position: number;
};

export type AiCitationGapRunRow = {
  runId: string;
  model: string;
  observedAt: string;
  citations: AiCitationGapCitationRow[];
};

export type AiCitationGapInput = {
  periodFrom: string;
  periodTo: string;
  observationCount: number;
  /** Canonical first-party domain (lowercased, leading `www.` folded). */
  projectDomain: string;
  runs: AiCitationGapRunRow[];
  thresholds: Record<string, string | number | boolean>;
};

function isAiCitationGapInput(
  value: unknown,
): value is AiCitationGapInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "runs" in value &&
    Array.isArray((value as { runs?: unknown }).runs) &&
    "periodFrom" in value &&
    typeof (value as { periodFrom?: unknown }).periodFrom === "string" &&
    "periodTo" in value &&
    typeof (value as { periodTo?: unknown }).periodTo === "string" &&
    "observationCount" in value &&
    typeof (value as { observationCount?: unknown }).observationCount ===
      "number" &&
    "projectDomain" in value &&
    typeof (value as { projectDomain?: unknown }).projectDomain === "string" &&
    "thresholds" in value &&
    typeof (value as { thresholds?: unknown }).thresholds === "object" &&
    (value as { thresholds?: unknown }).thresholds !== null
  );
}

/** Canonical domain identity: lowercase, leading `www.` folded. */
function canonicalCitationDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "");
}

function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

function domainList(domains: string[]): string {
  const shown = domains.slice(0, 3).join(", ");
  const rest = domains.length - Math.min(3, domains.length);
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/** Deterministic sort: newest first, runId as the stable tiebreak. */
function compareRuns(a: AiCitationGapRunRow, b: AiCitationGapRunRow): number {
  if (a.observedAt !== b.observedAt) {
    return a.observedAt < b.observedAt ? 1 : -1;
  }
  return a.runId < b.runId ? -1 : 1;
}

export async function fetchAiCitationGapInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<AiCitationGapInput> {
  const freshnessDays = thresholdNumber(ctx.thresholds, "freshnessDays");
  const maxRunsRead = thresholdNumber(ctx.thresholds, "maxRunsRead");
  const smallSampleFloor = thresholdNumber(ctx.thresholds, "smallSampleFloor");
  const frequentlyCitedMinRuns = thresholdNumber(
    ctx.thresholds,
    "frequentlyCitedMinRuns",
  );

  // First-party identity: a missing project domain makes "cited without us"
  // unverifiable — mirror competitor_gap and skip loudly (never guess).
  const firstPartyDomain = canonicalProjectDomain(await getProjectDomain(projectId));
  if (!firstPartyDomain) {
    throw new InsufficientCoverageError(
      "ai_citation_gap: project has no domain",
    );
  }

  const since = new Date(
    Date.now() - freshnessDays * 86_400_000,
  ).toISOString();
  const runs = await AiSearchObservationRepository.getRunsForProject(
    projectId,
    since,
    maxRunsRead,
  );
  if (runs.length === 0) {
    throw new InsufficientCoverageError(
      `ai_citation_gap: no recorded AI search observations in the last ${freshnessDays}d`,
    );
  }

  const citations = await AiSearchObservationRepository.getCitationsForRuns(
    projectId,
    runs.map((run) => run.id),
  );
  const citationsByRun = new Map<string, AiCitationGapCitationRow[]>();
  for (const citation of citations) {
    const bucket = citationsByRun.get(citation.runId) ?? [];
    bucket.push({
      url: citation.url,
      domain: canonicalCitationDomain(citation.domain),
      title: citation.title,
      position: citation.position,
    });
    citationsByRun.set(citation.runId, bucket);
  }

  const rows: AiCitationGapRunRow[] = runs.map((run) => ({
    runId: run.id,
    model: run.model,
    observedAt: run.observedAt,
    citations: citationsByRun.get(run.id) ?? [],
  }));
  rows.sort(compareRuns);

  const observed = rows.map((row) => row.observedAt);
  return {
    periodFrom: observed.reduce((min, at) => (at < min ? at : min)),
    periodTo: observed.reduce((max, at) => (at > max ? at : max)),
    observationCount: rows.length,
    projectDomain: firstPartyDomain,
    runs: rows,
    thresholds: {
      freshnessDays,
      maxRunsRead,
      smallSampleFloor,
      frequentlyCitedMinRuns,
    },
  };
}

/** Confidence per family; small samples emit at the floor confidence. */
const CONFIDENCE_BY_FAMILY = {
  cited_without_us: 65,
  frequent_third_party: 70,
  no_cited_sources: 50,
} as const;

const SMALL_SAMPLE_CONFIDENCE = 45;

type FamilyKey = keyof typeof CONFIDENCE_BY_FAMILY;

function familyConfidence(
  family: FamilyKey,
  smallSample: boolean,
): number {
  return smallSample
    ? SMALL_SAMPLE_CONFIDENCE
    : CONFIDENCE_BY_FAMILY[family];
}

export function detectAiCitationGap(
  ctx: DetectorContext,
  input: AiCitationGapInput,
): FindingDraft[] {
  const smallSampleFloor = thresholdNumber(ctx.thresholds, "smallSampleFloor");
  const frequentlyCitedMinRuns = thresholdNumber(
    ctx.thresholds,
    "frequentlyCitedMinRuns",
  );

  const smallSample = input.observationCount < smallSampleFloor;
  const periods = { from: input.periodFrom, to: input.periodTo };
  const findings: FindingDraft[] = [];

  const detectedAt = new Date().toISOString();
  const partialData = smallSample
    ? [
        `small_sample:${input.observationCount} observations (floor ${smallSampleFloor})`,
      ]
    : [];

  // Runs citing at least one page, none of them first-party.
  const runsCitingOthers = input.runs.filter(
    (run) =>
      run.citations.length > 0 &&
      !run.citations.some(
        (citation) => citation.domain === input.projectDomain,
      ),
  );

  for (const run of runsCitingOthers) {
    const domains = Array.from(
      new Set(run.citations.map((citation) => citation.domain)),
    ).toSorted((a, b) => (a < b ? -1 : 1));
    const firstCitation = run.citations.reduce((best, citation) =>
      citation.position < best.position ? citation : best,
    );
    const topPosition = firstCitation.position;

    findings.push({
      entityKey: `cited_without_us:${run.runId}`,
      entity: {
        family: "cited_without_us",
        runId: run.runId,
        model: run.model,
        observedAt: run.observedAt,
        citationCount: run.citations.length,
        firstCitedDomain: firstCitation.domain,
        firstPosition: topPosition,
      },
      explanationFact:
        `The ${run.model} answer observed on ${dateLabel(run.observedAt)} ` +
        `cited ${run.citations.length} third-party page(s) from ` +
        `${domainList(domains)}; no page of the project domain ` +
        `${input.projectDomain} was cited in that answer.`,
      evidence: {
        metrics: {
          observationCount: input.observationCount,
          smallSample,
          citationCount: run.citations.length,
          distinctDomainCount: domains.length,
          firstPartyCited: false,
          firstPosition: topPosition,
        },
        periods,
        sources: ["ai_search"],
        sourceRefs: { aiSearchRunIds: [run.runId] },
        thresholdsApplied: input.thresholds,
        correlations: domains.slice(1).map((domain) => ({
          entityRef: domain,
          note: `Domain ${domain} was also cited in this answer`,
        })),
        evidenceType: "observational",
        partialData,
        confidenceInputs: {
          observationCount: input.observationCount,
          citationCount: run.citations.length,
          smallSample,
        },
      },
      detectedAt,
      confidenceScore: familyConfidence("cited_without_us", smallSample),
      coverageFlags: {
        aiSearchObservations: input.observationCount,
        smallSample,
      },
    });
  }

  // Third-party domains cited in enough distinct runs (once per run).
  const runsByDomain = new Map<string, string[]>();
  for (const run of input.runs) {
    const domains = new Set(
      run.citations
        .map((citation) => citation.domain)
        .filter((domain) => domain !== input.projectDomain),
    );
    for (const domain of domains) {
      const runsCiting = runsByDomain.get(domain) ?? [];
      runsCiting.push(run.runId);
      runsByDomain.set(domain, runsCiting);
    }
  }
  const frequentDomains = Array.from(runsByDomain.entries())
    .filter(([, runIds]) => runIds.length >= frequentlyCitedMinRuns)
    .toSorted(([a], [b]) => (a < b ? -1 : 1));

  for (const [domain, runIds] of frequentDomains) {
    const runsCitingCount = runIds.length;
    const sharePct = Math.round((100 * runsCitingCount) / input.observationCount);

    findings.push({
      entityKey: `frequent_third_party:${domain}`,
      entity: {
        family: "frequent_third_party",
        domain,
        runsCitedIn: runsCitingCount,
        observationCount: input.observationCount,
      },
      explanationFact:
        `Third-party domain ${domain} was cited in ${runsCitingCount} of ` +
        `${input.observationCount} recorded AI answers (${sharePct}%).`,
      evidence: {
        metrics: {
          observationCount: input.observationCount,
          smallSample,
          runsCitingDomain: runsCitingCount,
          runSharePct: sharePct,
        },
        periods,
        sources: ["ai_search"],
        sourceRefs: { aiSearchRunIds: runIds.slice(0, 50) },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData,
        confidenceInputs: {
          observationCount: input.observationCount,
          runsCitingDomain: runsCitingCount,
          smallSample,
        },
      },
      detectedAt,
      confidenceScore: familyConfidence("frequent_third_party", smallSample),
      coverageFlags: {
        aiSearchObservations: input.observationCount,
        smallSample,
      },
    });
  }

  // Runs that cited no sources at all — a gap, not a missing observation.
  for (const run of input.runs.filter(
    (row) => row.citations.length === 0,
  )) {
    findings.push({
      entityKey: `no_cited_sources:${run.runId}`,
      entity: {
        family: "no_cited_sources",
        runId: run.runId,
        model: run.model,
        observedAt: run.observedAt,
      },
      explanationFact:
        `The ${run.model} answer observed on ${dateLabel(run.observedAt)} ` +
        `cited no sources at all.`,
      evidence: {
        metrics: {
          observationCount: input.observationCount,
          smallSample,
          citationCount: 0,
        },
        periods,
        sources: ["ai_search"],
        sourceRefs: { aiSearchRunIds: [run.runId] },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData,
        confidenceInputs: {
          observationCount: input.observationCount,
          smallSample,
        },
      },
      detectedAt,
      confidenceScore: familyConfidence("no_cited_sources", smallSample),
      coverageFlags: {
        aiSearchObservations: input.observationCount,
        smallSample,
      },
    });
  }

  return findings;
}

export const aiCitationGapDetector: DetectorDef = {
  detectorKey: "ai_citation_gap",
  version: 1,
  requiredSources: ["ai_search"],
  optionalCorroborators: [],
  // Framework floor sits below the small-sample confidence so labelled
  // findings still emit (spec 020 SC-004: small samples emit, labelled).
  minConfidenceToEmit: 40,
  // The ai_search source has no grain-coverage machinery: the fetcher
  // enforces the real contract — fresh recorded observations within the
  // injected freshness window, else InsufficientCoverageError (skip).
  coverage: [{ source: "ai_search", grains: ["run"], minCoverageRatio: 1 }],
  detect: (ctx, input) => {
    if (!isAiCitationGapInput(input)) {
      throw new Error("ai_citation_gap: mistyped input");
    }
    return detectAiCitationGap(ctx, input);
  },
};