import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  canonicalJson,
  findingSchema,
  sha256HexFull,
  stableHash,
  type Finding,
} from "@/shared/intelligence";

/**
 * Frozen R2 artifact store (final-plan §6). Findings freeze into a
 * content-addressed manifest + chunks per run; the DB row only holds
 * pointers. Keys embed FULL SHA-256 digests (64 hex, never truncated).
 */

export const FINDINGS_SCHEMA_VERSION = 3;
export const FINDINGS_PER_CHUNK = 1000;

export const ARTIFACT_ERROR_CLASSES = [
  "ARTIFACT_HASH_MISMATCH",
  "ARTIFACT_CORRUPT",
  "ARTIFACT_MISSING",
  "ARTIFACT_KEY_COLLISION",
] as const;
export type ArtifactErrorClass = (typeof ARTIFACT_ERROR_CLASSES)[number];

export class ArtifactError extends Error {
  readonly errorClass: ArtifactErrorClass;
  constructor(errorClass: ArtifactErrorClass, message: string) {
    super(`${errorClass}: ${message}`);
    this.errorClass = errorClass;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const artifactChunkSchema = z
  .object({
    detectorKey: z.string().min(1),
    seq: z.number().int().min(0),
    objectKey: z.string().min(1),
    chunkHash: z.string().length(64),
    findingCount: z.number().int().min(0),
  })
  .strict();

const artifactManifestSchema = z
  .object({
    schemaVersion: z.literal(FINDINGS_SCHEMA_VERSION),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    inputHash: z.string().min(1),
    inputSourceVersions: z.unknown(),
    detectorVersions: z.record(z.string(), z.number()),
    thresholdVersion: z.number().int(),
    detectedAt: z.string().min(1),
    chunks: z.array(artifactChunkSchema),
    totalFindings: z.number().int().min(0),
    artifactHash: z.string().length(64),
  })
  .strict();

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

function chunkSeq(seq: number): string {
  return String(seq).padStart(3, "0");
}

async function r2GetText(key: string): Promise<string | null> {
  const object = await env.R2.get(key);
  if (!object) return null;
  return object.text();
}

/**
 * Existence check with identical-reuse: a colliding key holding byte-identical
 * content is reused (idempotent retry); a colliding key with DIFFERENT content
 * fails the run — recovery is always a new run (fresh runId → fresh keys).
 */
async function putIfAbsentOrIdentical(
  key: string,
  body: string,
): Promise<{ reused: boolean; sizeBytes: number }> {
  const head = await env.R2.head(key);
  if (head) {
    const existing = await r2GetText(key);
    if (existing === body) return { reused: true, sizeBytes: body.length };
    throw new ArtifactError(
      "ARTIFACT_KEY_COLLISION",
      `R2 key ${key} already holds different content`,
    );
  }
  await env.R2.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
  return { reused: false, sizeBytes: body.length };
}

export type ArtifactPointers = {
  manifestKey: string;
  manifestHash: string;
  findingsCount: number;
  chunkKeys: string[];
};

export async function writeArtifact(input: {
  projectId: string;
  runId: string;
  findings: Finding[];
  inputHash: string;
  inputSourceVersions: unknown;
  detectorVersions: Record<string, number>;
  thresholdVersion: number;
  detectedAt?: string;
}): Promise<ArtifactPointers> {
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const byDetector = new Map<string, Finding[]>();
  for (const finding of input.findings) {
    const group = byDetector.get(finding.detectorKey) ?? [];
    group.push(finding);
    byDetector.set(finding.detectorKey, group);
  }

  const chunks: Array<{
    detectorKey: string;
    seq: number;
    objectKey: string;
    chunkHash: string;
    findingCount: number;
  }> = [];
  const chunkKeys: string[] = [];
  let totalBytes = 0;

  for (const [detectorKey, group] of [...byDetector.entries()].toSorted(
    ([a], [b]) => (a < b ? -1 : 1),
  )) {
    for (let offset = 0; offset < group.length; offset += FINDINGS_PER_CHUNK) {
      const slice = group.slice(offset, offset + FINDINGS_PER_CHUNK);
      const seq = Math.floor(offset / FINDINGS_PER_CHUNK);
      // Canonical form is the hashed + stored form (stable across runtimes).
      const body = canonicalJson(JSON.parse(canonicalJson(slice)) as unknown);
      const chunkHash = await sha256HexFull(body);
      const objectKey =
        `intelligence-runs/${input.projectId}/${input.runId}/` +
        `findings-${detectorKey}-${chunkSeq(seq)}-${chunkHash}.json`;
      const written = await putIfAbsentOrIdentical(objectKey, body);
      totalBytes += written.sizeBytes;
      chunks.push({
        detectorKey,
        seq,
        objectKey,
        chunkHash,
        findingCount: slice.length,
      });
      chunkKeys.push(objectKey);
    }
  }

  const manifestBody = {
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    runId: input.runId,
    projectId: input.projectId,
    inputHash: input.inputHash,
    inputSourceVersions: input.inputSourceVersions ?? null,
    detectorVersions: input.detectorVersions,
    thresholdVersion: input.thresholdVersion,
    detectedAt,
    chunks,
    totalFindings: input.findings.length,
  };
  const artifactHash = await stableHash(manifestBody);
  const manifestKey =
    `intelligence-runs/${input.projectId}/${input.runId}/` +
    `manifest-${artifactHash}.json`;
  const manifestText = canonicalJson({ ...manifestBody, artifactHash });
  const manifestWritten = await putIfAbsentOrIdentical(
    manifestKey,
    manifestText,
  );
  totalBytes += manifestWritten.sizeBytes;

  console.log(
    `[intelligence:artifact] write run ${input.runId} ` +
      `hash8=${artifactHash.slice(0, 8)} chunks=${chunks.length} ` +
      `findings=${input.findings.length} sizeBytes=${totalBytes}`,
  );

  return {
    manifestKey,
    manifestHash: artifactHash,
    findingsCount: input.findings.length,
    chunkKeys,
  };
}

export type LoadedArtifact = {
  manifest: ArtifactManifest;
  findings: Finding[];
};

export async function loadArtifact(
  manifestKey: string,
  manifestHash: string,
): Promise<LoadedArtifact> {
  const text = await r2GetText(manifestKey);
  if (text === null) {
    throw new ArtifactError(
      "ARTIFACT_MISSING",
      `Manifest object missing: ${manifestKey}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ArtifactError(
      "ARTIFACT_CORRUPT",
      `Manifest unparsable: ${manifestKey}`,
    );
  }
  if (!isRecord(raw)) {
    throw new ArtifactError(
      "ARTIFACT_CORRUPT",
      `Manifest is not an object: ${manifestKey}`,
    );
  }
  // The embedded artifactHash covers the manifest WITHOUT itself; strip it
  // before verifying against the DB pointer.
  const { artifactHash: embeddedHash, ...manifestWithoutHash } = raw;
  if (
    (await sha256HexFull(canonicalJson(manifestWithoutHash))) !==
      manifestHash ||
    embeddedHash !== manifestHash
  ) {
    throw new ArtifactError(
      "ARTIFACT_HASH_MISMATCH",
      `Manifest hash mismatch: ${manifestKey}`,
    );
  }
  let manifest: ArtifactManifest;
  try {
    manifest = artifactManifestSchema.parse(raw);
  } catch {
    throw new ArtifactError(
      "ARTIFACT_CORRUPT",
      `Manifest unparsable: ${manifestKey}`,
    );
  }

  const findings: Finding[] = [];
  for (const chunk of manifest.chunks) {
    const chunkText = await r2GetText(chunk.objectKey);
    if (chunkText === null) {
      throw new ArtifactError(
        "ARTIFACT_MISSING",
        `Chunk object missing: ${chunk.objectKey}`,
      );
    }
    if (
      (await sha256HexFull(canonicalJson(JSON.parse(chunkText) as unknown))) !==
      chunk.chunkHash
    ) {
      throw new ArtifactError(
        "ARTIFACT_HASH_MISMATCH",
        `Chunk hash mismatch: ${chunk.objectKey}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunkText) as unknown;
    } catch {
      throw new ArtifactError(
        "ARTIFACT_CORRUPT",
        `Chunk unparsable: ${chunk.objectKey}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ArtifactError(
        "ARTIFACT_CORRUPT",
        `Chunk is not a finding array: ${chunk.objectKey}`,
      );
    }
    for (const entry of parsed) {
      const validated = findingSchema.safeParse(entry);
      if (!validated.success) {
        throw new ArtifactError(
          "ARTIFACT_CORRUPT",
          `Chunk holds an invalid finding: ${chunk.objectKey}`,
        );
      }
      findings.push(validated.data);
    }
  }

  if (findings.length !== manifest.totalFindings) {
    throw new ArtifactError(
      "ARTIFACT_CORRUPT",
      `Chunk finding total ${findings.length} != manifest ${manifest.totalFindings}`,
    );
  }

  return { manifest, findings };
}

export const ArtifactStore = {
  writeArtifact,
  loadArtifact,
};
