import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { aiSearchCitations, aiSearchRuns } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import { sha256HexFull } from "@/shared/intelligence";

/**
 * Storage for the AI search observations (spec 020).
 *
 * Privacy: the prompt and the answer never reach this layer as text. The
 * caller passes hashes and counts, plus the sanitized citation URLs that the
 * existing extraction already produced.
 */

export type AiSearchCitationRow = {
  url: string;
  domain: string;
  title: string | null;
  position: number;
};

export type AiSearchRunRow = {
  projectId: string;
  provider: string;
  model: string;
  modelName: string | null;
  /** Hash of the normalized prompt. */
  promptHash: string;
  promptLength: number;
  webSearch: boolean;
  countryCode: string | null;
  outputTokens: number | null;
  fanOutCount: number;
  citationCount: number;
  /** Content hash of the observed answer. */
  eventKey: string;
  observedAt: string;
  citations: AiSearchCitationRow[];
};

export type StoredAiSearchRun = {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  modelName: string | null;
  promptHash: string;
  promptLength: number;
  webSearch: boolean;
  countryCode: string | null;
  outputTokens: number | null;
  fanOutCount: number;
  citationCount: number;
  eventKey: string;
  observedAt: string;
};

export type StoredAiSearchCitation = {
  runId: string;
  url: string;
  domain: string;
  title: string | null;
  position: number;
  citedAt: string;
};

async function runId(row: {
  projectId: string;
  eventKey: string;
  model: string;
}): Promise<string> {
  return (
    await sha256HexFull(
      [row.projectId, row.eventKey, row.model].join("|"),
    )
  ).slice(0, 36);
}

/**
 * Record one observed model answer and the pages it cited. Idempotent: the
 * same observation (same answer content, same model) keeps the same run id, so
 * a repeat never duplicates rows.
 */
async function recordRun(row: AiSearchRunRow): Promise<string> {
  const id = await runId(row);
  await db
    .insert(aiSearchRuns)
    .values({
      id,
      projectId: row.projectId,
      provider: row.provider,
      model: row.model,
      modelName: row.modelName,
      promptHash: row.promptHash,
      promptLength: row.promptLength,
      webSearch: row.webSearch,
      countryCode: row.countryCode,
      outputTokens: row.outputTokens,
      fanOutCount: row.fanOutCount,
      citationCount: row.citationCount,
      status: "success" as const,
      eventKey: row.eventKey,
      observedAt: row.observedAt,
    })
    .onConflictDoNothing();
  if (row.citations.length > 0) {
    // Ids are derived from (runId, url), so retries converge on the same rows.
    const citationRows = await Promise.all(
      row.citations.map(async (citation) => ({
        id: (await sha256HexFull([id, citation.url].join("|"))).slice(0, 36),
        runId: id,
        projectId: row.projectId,
        citedAt: row.observedAt,
        ...citation,
      })),
    );
    await executeInBatches(citationRows, (tx, citation) =>
      tx.insert(aiSearchCitations).values(citation).onConflictDoNothing(),
    );
  }
  return id;
}

/** Stored runs for a project inside a freshness window (newest first). */
async function getRunsForProject(
  projectId: string,
  since: string,
  limit = 500,
): Promise<StoredAiSearchRun[]> {
  return db
    .select({
      id: aiSearchRuns.id,
      projectId: aiSearchRuns.projectId,
      provider: aiSearchRuns.provider,
      model: aiSearchRuns.model,
      modelName: aiSearchRuns.modelName,
      promptHash: aiSearchRuns.promptHash,
      promptLength: aiSearchRuns.promptLength,
      webSearch: aiSearchRuns.webSearch,
      countryCode: aiSearchRuns.countryCode,
      outputTokens: aiSearchRuns.outputTokens,
      fanOutCount: aiSearchRuns.fanOutCount,
      citationCount: aiSearchRuns.citationCount,
      eventKey: aiSearchRuns.eventKey,
      observedAt: aiSearchRuns.observedAt,
    })
    .from(aiSearchRuns)
    .where(
      and(
        eq(aiSearchRuns.projectId, projectId),
        gte(aiSearchRuns.observedAt, since),
      ),
    )
    .orderBy(desc(aiSearchRuns.observedAt))
    .limit(limit);
}

/** Citations of the given runs, ordered by run and position. */
async function getCitationsForRuns(
  projectId: string,
  runIds: string[],
): Promise<StoredAiSearchCitation[]> {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: aiSearchCitations.runId,
      url: aiSearchCitations.url,
      domain: aiSearchCitations.domain,
      title: aiSearchCitations.title,
      position: aiSearchCitations.position,
      citedAt: aiSearchCitations.citedAt,
    })
    .from(aiSearchCitations)
    .where(
      and(
        eq(aiSearchCitations.projectId, projectId),
        inArray(aiSearchCitations.runId, runIds),
      ),
    )
    .orderBy(aiSearchCitations.runId, aiSearchCitations.position);
}

export const AiSearchObservationRepository = {
  recordRun,
  getRunsForProject,
  getCitationsForRuns,
};
