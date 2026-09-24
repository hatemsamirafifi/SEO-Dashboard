import { beforeEach, describe, expect, it, vi } from "vitest";

const r2 = vi.hoisted(() => ({
  objects: new Map<string, string>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const body = r2.objects.get(key);
        if (body === undefined) return null;
        return { text: async () => body };
      },
      head: async (key: string) => (r2.objects.has(key) ? { key } : null),
      put: async (key: string, body: string) => {
        r2.objects.set(key, body);
      },
    },
  },
}));

import { FINDINGS_PER_CHUNK, ArtifactStore } from "./ArtifactStore";
import type { Finding } from "@/shared/intelligence";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingKey: "a".repeat(64),
    detectorKey: "low_ctr_query",
    detectorVersion: 1,
    projectId: "project-1",
    entityKey: "entity-1",
    entity: { query: "entity-1" },
    explanationFact: "Entity entity-1 has low CTR.",
    evidence: {
      metrics: { clicks: 10 },
      sources: ["gsc"],
      thresholdsApplied: { minImpressions: 100 },
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: { coverage: 1 },
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 80,
    coverageFlags: {},
    ...overrides,
  };
}

const BASE = {
  projectId: "project-1",
  runId: "run-1",
  inputHash: "b".repeat(64),
  inputSourceVersions: { gsc: "sync-1" },
  detectorVersions: { low_ctr_query: 1 },
  thresholdVersion: 1,
  detectedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  r2.objects.clear();
});

describe("ArtifactStore", () => {
  it("round-trips an empty finding set as a valid empty artifact", async () => {
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [],
    });
    expect(pointers.findingsCount).toBe(0);
    expect(pointers.chunkKeys).toEqual([]);
    expect(pointers.manifestHash).toHaveLength(64);
    expect(pointers.manifestKey).toContain(
      `manifest-${pointers.manifestHash}.json`,
    );

    const loaded = await ArtifactStore.loadArtifact(
      pointers.manifestKey,
      pointers.manifestHash,
    );
    expect(loaded.findings).toEqual([]);
    expect(loaded.manifest.totalFindings).toBe(0);
    expect(loaded.manifest.schemaVersion).toBe(3);
  });

  it("round-trips findings grouped by detector with full-digest keys", async () => {
    const rows = [
      finding({ findingKey: "a".repeat(64), entityKey: "e1" }),
      finding({ findingKey: "c".repeat(64), entityKey: "e2" }),
    ];
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: rows,
    });
    expect(pointers.chunkKeys).toHaveLength(1);
    for (const key of pointers.chunkKeys) {
      expect(key).toMatch(/findings-low_ctr_query-000-[0-9a-f]{64}\.json$/);
    }
    const loaded = await ArtifactStore.loadArtifact(
      pointers.manifestKey,
      pointers.manifestHash,
    );
    expect(loaded.findings).toHaveLength(2);
  });

  it("chunks at 1000 findings with manifest-bound hashes", async () => {
    const rows = Array.from({ length: FINDINGS_PER_CHUNK + 5 }, (_, i) =>
      finding({
        findingKey: `${i}`.padStart(64, "0"),
        entityKey: `e${i}`,
      }),
    );
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: rows,
    });
    expect(pointers.chunkKeys).toHaveLength(2);
    const loaded = await ArtifactStore.loadArtifact(
      pointers.manifestKey,
      pointers.manifestHash,
    );
    expect(loaded.findings).toHaveLength(FINDINGS_PER_CHUNK + 5);
    expect(loaded.manifest.chunks.map((chunk) => chunk.findingCount)).toEqual([
      FINDINGS_PER_CHUNK,
      5,
    ]);
  });

  it("reuses byte-identical keys and collides on different content", async () => {
    const first = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [finding()],
    });
    const second = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [finding()],
    });
    expect(second.manifestKey).toBe(first.manifestKey);

    // A key that already holds DIFFERENT content fails the run: simulate a
    // foreign writer by overwriting the chunk, then retry the identical write.
    const chunkKey = first.chunkKeys[0];
    if (!chunkKey) throw new Error("expected a chunk key");
    r2.objects.set(chunkKey, JSON.stringify([{ foreign: true }]));
    await expect(
      ArtifactStore.writeArtifact({ ...BASE, findings: [finding()] }),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_KEY_COLLISION" });
  });

  it("fails loads on missing manifests", async () => {
    await expect(
      ArtifactStore.loadArtifact("missing.json", "a".repeat(64)),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_MISSING" });
  });

  it("fails loads on manifest hash mismatch", async () => {
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [finding()],
    });
    await expect(
      ArtifactStore.loadArtifact(pointers.manifestKey, "0".repeat(64)),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_HASH_MISMATCH" });
  });

  it("fails loads on corrupt manifests and chunks", async () => {
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [finding()],
    });
    r2.objects.set(pointers.manifestKey, "not json{{{");
    await expect(
      ArtifactStore.loadArtifact(pointers.manifestKey, pointers.manifestHash),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_CORRUPT" });

    const pointers2 = await ArtifactStore.writeArtifact({
      ...BASE,
      runId: "run-2",
      findings: [finding()],
    });
    const chunkKey = pointers2.chunkKeys[0];
    if (!chunkKey) throw new Error("expected a chunk key");
    r2.objects.delete(chunkKey);
    await expect(
      ArtifactStore.loadArtifact(pointers2.manifestKey, pointers2.manifestHash),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_MISSING" });
  });

  it("fails loads when a chunk holds an invalid finding", async () => {
    const { canonicalJson, sha256HexFull, stableHash } =
      await import("@/shared/intelligence");
    const pointers = await ArtifactStore.writeArtifact({
      ...BASE,
      findings: [finding()],
    });
    const chunkKey = pointers.chunkKeys[0];
    if (!chunkKey) throw new Error("expected a chunk key");
    // Tamper the chunk, then re-point the manifest (chunk hash + manifest
    // hash) so the corrupt-content path — not the mismatch path — is hit.
    const tampered = canonicalJson([{ nope: true }]);
    r2.objects.set(chunkKey, tampered);
    const manifestText = r2.objects.get(pointers.manifestKey);
    if (!manifestText) throw new Error("expected a manifest");
    const manifest: unknown = JSON.parse(manifestText);
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("chunks" in manifest) ||
      !Array.isArray(manifest.chunks) ||
      !("artifactHash" in manifest) ||
      typeof manifest.artifactHash !== "string"
    ) {
      throw new Error("expected a manifest object");
    }
    const chunk: unknown = manifest.chunks[0];
    if (
      typeof chunk !== "object" ||
      chunk === null ||
      !("chunkHash" in chunk) ||
      typeof chunk.chunkHash !== "string"
    ) {
      throw new Error("expected a manifest chunk");
    }
    chunk.chunkHash = await sha256HexFull(tampered);
    const withoutHash: Record<string, unknown> = { ...manifest };
    delete withoutHash.artifactHash;
    const nextHash = await stableHash(withoutHash);
    const nextKey = pointers.manifestKey.replace(
      pointers.manifestHash,
      nextHash,
    );
    r2.objects.set(
      nextKey,
      canonicalJson({ ...withoutHash, artifactHash: nextHash }),
    );
    await expect(
      ArtifactStore.loadArtifact(nextKey, nextHash),
    ).rejects.toMatchObject({ errorClass: "ARTIFACT_CORRUPT" });
  });
});
