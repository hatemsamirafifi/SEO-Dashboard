import { describe, expect, it } from "vitest";

function mapLegacyRow(row: {
  id: number;
  position: number | null;
  rankingStatus: string | null;
}) {
  // Replicates the non-destructive legacy migration rule:
  // legacy position != null -> RANKED
  // legacy position == null -> NOT automatically NO_RESULT (kept null/unproven)
  const migratedStatus =
    row.rankingStatus ??
    (row.position !== null ? "RANKED" : null);

  return {
    ...row,
    rankingStatus: migratedStatus,
  };
}

describe("Legacy rank_snapshots migration semantics", () => {

  it("maps legacy row with position != null to RANKED", () => {
    const legacyRow = { id: 1, position: 5, rankingStatus: null };
    const migrated = mapLegacyRow(legacyRow);

    expect(migrated.rankingStatus).toBe("RANKED");
    expect(migrated.position).toBe(5);
  });

  it("does NOT automatically classify legacy position == null as NO_RESULT", () => {
    const legacyRow = { id: 2, position: null, rankingStatus: null };
    const migrated = mapLegacyRow(legacyRow);

    expect(migrated.rankingStatus).toBeNull();
    expect(migrated.rankingStatus).not.toBe("NO_RESULT");
    expect(migrated.rankingStatus).not.toBe("CHECK_FAILED");
  });

  it("preserves explicit new snapshot statuses without alteration", () => {
    expect(mapLegacyRow({ id: 3, position: null, rankingStatus: "NO_RESULT" }).rankingStatus).toBe("NO_RESULT");
    expect(mapLegacyRow({ id: 4, position: null, rankingStatus: "CHECK_FAILED" }).rankingStatus).toBe("CHECK_FAILED");
    expect(mapLegacyRow({ id: 5, position: 12, rankingStatus: "RANKED" }).rankingStatus).toBe("RANKED");
  });

  it("preserves total row count and keeps ambiguous legacy rows identifiable", () => {
    const legacyDataset = [
      { id: 1, position: 5, rankingStatus: null },
      { id: 2, position: 10, rankingStatus: null },
      { id: 3, position: null, rankingStatus: null },
      { id: 4, position: null, rankingStatus: null },
      { id: 5, position: 22, rankingStatus: null },
    ];

    const migrated = legacyDataset.map(mapLegacyRow);

    expect(migrated).toHaveLength(legacyDataset.length);
    const ambiguousRows = migrated.filter((r) => r.position === null && r.rankingStatus === null);
    expect(ambiguousRows).toHaveLength(2);
    expect(ambiguousRows.map((r) => r.id)).toEqual([3, 4]);

    const rankedRows = migrated.filter((r) => r.rankingStatus === "RANKED");
    expect(rankedRows).toHaveLength(3);
  });
});
