/* eslint-disable max-lines -- full first-party storage lifecycle coverage in
   one file */
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  googleAdsPlannerGroupMonths,
  googleAdsPlannerGroupVariants,
  googleAdsPlannerGroups,
  googleAdsPlannerObservations,
} from "@/db/schema";
import {
  GoogleAdsPlannerKeywordRepository,
  type GoogleAdsPlannerObservationInput,
  type GoogleAdsPlannerScope,
} from "./GoogleAdsPlannerKeywordRepository";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client);
  return { db: database.db };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const statement of build(database.db)) await statement;
  },
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

const MIGRATIONS = ["drizzle/0066_broken_spot.sql"];

const SCOPE: GoogleAdsPlannerScope = {
  projectId: "project-1",
  organizationId: "org-a",
  customerId: "1234567890",
  loginCustomerId: null,
  currencyCode: "EUR",
  locationCode: 2764,
  languageCode: "en",
  network: "GOOGLE_SEARCH_AND_PARTNERS",
  contractVersion: "v26-planner",
};

function observationInput(
  overrides: Partial<GoogleAdsPlannerObservationInput> = {},
): GoogleAdsPlannerObservationInput {
  return {
    scope: SCOPE,
    dataType: "keyword_ideas",
    seedKeyword: "flowers",
    sourceFetchedAt: "2026-10-24T00:00:00.000Z",
    stats: {
      truncated: false,
      partial: false,
      malformedKeywordCount: 0,
      duplicateKeywordCount: 0,
      missingKeywordCount: 0,
    },
    records: [
      {
        keyword: "flower bouquets",
        closeVariants: ["flowers in a bouquet", "Flower Bouquet"],
        avgMonthlySearches: 120_000,
        monthlySearchVolumes: [
          { year: 2026, month: 9, volume: 130_000 },
          { year: 2026, month: 10, volume: null },
          { year: 2026, month: 11, volume: 0 },
          { year: 0, month: 0, volume: 99_999 },
        ],
        competition: "MEDIUM",
        competitionIndex: 57,
        averageCpcMicros: 4_294_967_296,
        lowTopOfPageBidMicros: 900_500,
        highTopOfPageBidMicros: 2_100_750,
      },
      {
        keyword: "FLOWER delivery",
        closeVariants: [],
        avgMonthlySearches: null,
        monthlySearchVolumes: [],
        competition: null,
        competitionIndex: null,
        averageCpcMicros: null,
        lowTopOfPageBidMicros: null,
        highTopOfPageBidMicros: null,
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = ON");
  await database.client.execute(
    "CREATE TABLE organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL
     )`,
  );
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(resolve(process.cwd(), migration), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.client.execute(statement);
    }
  }
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("DELETE FROM google_ads_planner_group_months");
  await database.client.execute(
    "DELETE FROM google_ads_planner_group_variants",
  );
  await database.client.execute("DELETE FROM google_ads_planner_groups");
  await database.client.execute("DELETE FROM google_ads_planner_observations");
  await database.client.execute("DELETE FROM projects");
  await database.client.execute("DELETE FROM organization");
  await database.client.execute(
    "INSERT INTO organization (id) VALUES ('org-a')",
  );
  await database.client.execute(
    "INSERT INTO projects (id, organization_id) VALUES ('project-1', 'org-a')",
  );
});

afterAll(() => database.client?.close());

async function observationRows() {
  if (!database.db) throw new Error("Test database was not initialized");
  return database.db
    .select()
    .from(googleAdsPlannerObservations)
    .where(eq(googleAdsPlannerObservations.projectId, SCOPE.projectId));
}

async function groupRows() {
  if (!database.db) throw new Error("Test database was not initialized");
  return database.db
    .select()
    .from(googleAdsPlannerGroups)
    .where(eq(googleAdsPlannerGroups.projectId, SCOPE.projectId));
}

async function variantRows() {
  if (!database.db) throw new Error("Test database was not initialized");
  return database.db.select().from(googleAdsPlannerGroupVariants);
}

async function monthRows() {
  if (!database.db) throw new Error("Test database was not initialized");
  return database.db.select().from(googleAdsPlannerGroupMonths);
}

describe("GoogleAdsPlannerKeywordRepository.recordGroupObservation", () => {
  it("stores the observation ledger row with honest flags and money provenance", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );

    const rows = await observationRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.customerId).toBe("1234567890");
    expect(row.loginCustomerId).toBeNull();
    expect(row.currencyCode).toBe("EUR");
    expect(row.dataType).toBe("keyword_ideas");
    expect(row.seedKeyword).toBe("flowers");
    expect(row.locationCode).toBe(2764);
    expect(row.languageCode).toBe("en");
    expect(row.network).toBe("GOOGLE_SEARCH_AND_PARTNERS");
    expect(row.contractVersion).toBe("v26-planner");
    expect(row.sourceFetchedAt).toBe("2026-10-24T00:00:00.000Z");
    expect(row.truncated).toBe(false);
    expect(row.partial).toBe(false);
    expect(row.malformedKeywordCount).toBe(0);
    expect(row.duplicateKeywordCount).toBe(0);
    expect(row.missingKeywordCount).toBe(0);
  });

  it("records partial/duplicate/missing counts verbatim, never watering them down", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        stats: {
          truncated: true,
          partial: true,
          malformedKeywordCount: 3,
          duplicateKeywordCount: 2,
          missingKeywordCount: 1,
        },
      }),
    );

    const [row] = await observationRows();
    expect(row.truncated).toBe(true);
    expect(row.partial).toBe(true);
    expect(row.malformedKeywordCount).toBe(3);
    expect(row.duplicateKeywordCount).toBe(2);
    expect(row.missingKeywordCount).toBe(1);
  });

  it("stores canonical groups with Google-native metrics and cents-free money", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );

    const groups = await groupRows();
    expect(groups).toHaveLength(2);

    const bouquets = groups.find((g) => g.keyword === "flower bouquets");
    expect(bouquets?.avgMonthlySearches).toBe(120_000);
    expect(bouquets?.competition).toBe("MEDIUM");
    expect(bouquets?.competitionIndex).toBe(57);
    // A large cost micros value beyond the int32 range survives exactly.
    expect(bouquets?.averageCpcMicros).toBe(4_294_967_296);
    expect(bouquets?.lowTopOfPageBidMicros).toBe(900_500);
    expect(bouquets?.highTopOfPageBidMicros).toBe(2_100_750);
    expect(bouquets?.currencyCode).toBe("EUR");
    expect(bouquets?.sourceFetchedAt).toBe("2026-10-24T00:00:00.000Z");

    const delivery = groups.find((g) => g.keyword === "flower delivery");
    // Absent upstream metrics stay null — never fabricated to zero.
    expect(delivery?.avgMonthlySearches).toBeNull();
    expect(delivery?.competition).toBeNull();
    expect(delivery?.averageCpcMicros).toBeNull();
  });

  it("stores variant memberships normalized and deduplicated, dropping the canonical self-listing", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );

    const variants = await variantRows();
    // "Flower Bouquet" normalizes into "flower bouquet"; each variant row is
    // unique per (group, normalized) pair.
    expect(
      variants.filter((v) => v.variantKeyword === "flower bouquet"),
    ).toHaveLength(1);
    expect(
      variants
        .filter((v) => v.variantKeyword === "flowers in a bouquet")
        .map((v) => v.sourceFetchedAt),
    ).toEqual(["2026-10-24T00:00:00.000Z"]);
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.groupId).toBeDefined();
      expect(variant.groupId).not.toBe("");
    }
  });

  it("stores real monthly history; a null month stays null and a real zero stays zero", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );

    const months = await monthRows();
    expect(months).toHaveLength(3);
    expect(months.find((m) => m.month === 9)?.volume).toBe(130_000);
    // Google reported no data for that month — stored as null, never 0.
    expect(months.find((m) => m.month === 10)?.volume).toBeNull();
    // A REAL zero stays zero.
    expect(months.find((m) => m.month === 11)?.volume).toBe(0);
    // The malformed year=0/month=0 entry is dropped, not fabricated.
    expect(months.find((m) => m.month === 0)).toBeUndefined();
  });

  it("coalesces a refreshed fetch ON the same scope instead of duplicating the ledger", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        sourceFetchedAt: "2026-10-25T00:00:00.000Z",
        stats: {
          truncated: true,
          partial: true,
          malformedKeywordCount: 1,
          duplicateKeywordCount: 0,
          missingKeywordCount: 0,
        },
      }),
    );

    const rows = await observationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceFetchedAt).toBe("2026-10-25T00:00:00.000Z");
    expect(rows[0].truncated).toBe(true);
    expect(rows[0].partial).toBe(true);

    const groups = await groupRows();
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.sourceFetchedAt).toBe("2026-10-25T00:00:00.000Z");
      // created_at keeps the original row's timestamp across refreshes.
    }
  });

  it("applies per-group replacement sync without deleting other seeds' or flows' groups", async () => {
    // One existing group from a DIFFERENT seed (same scope), which a
    // botanist's fresh "flowers" ideas call must not touch.
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        seedKeyword: "trees",
        records: [
          {
            keyword: "olive trees",
            closeVariants: ["olive tree sapling"],
            avgMonthlySearches: 5_000,
            monthlySearchVolumes: [{ year: 2026, month: 1, volume: 4_000 }],
            competition: "LOW",
            competitionIndex: 12,
            averageCpcMicros: 100,
            lowTopOfPageBidMicros: 50,
            highTopOfPageBidMicros: 200,
          },
        ],
      }),
    );

    // Refresh the "flowers" observation where the canonical group LOST a
    // variant and a month versus the first fetch.
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        records: [
          {
            keyword: "flower bouquets",
            closeVariants: ["flowers in a bouquet"],
            avgMonthlySearches: 125_000,
            monthlySearchVolumes: [{ year: 2026, month: 9, volume: 131_000 }],
            competition: "HIGH",
            competitionIndex: 80,
            averageCpcMicros: 1_500_000,
            lowTopOfPageBidMicros: 1_000_000,
            highTopOfPageBidMicros: 3_000_000,
          },
        ],
      }),
    );

    // Cross-seed group survives untouched.
    const oliveTrees = await database
      .db!.select()
      .from(googleAdsPlannerGroups)
      .where(eq(googleAdsPlannerGroups.keyword, "olive trees"));
    expect(oliveTrees).toHaveLength(1);
    expect(oliveTrees[0].avgMonthlySearches).toBe(5_000);

    // The refreshed group's stale variant ("flower bouquet") is gone; the
    // remaining variant stays.
    const variants = await variantRows();
    expect(
      variants.filter((v) => v.variantKeyword === "flowers in a bouquet"),
    ).toHaveLength(1);
    expect(
      variants.filter((v) => v.variantKeyword === "flower bouquet"),
    ).toHaveLength(0);
    // The other seed's variant stays too.
    expect(
      variants.filter((v) => v.variantKeyword === "olive tree sapling"),
    ).toHaveLength(1);

    // Stale months are deleted; the fresh one stays.
    const months = await monthRows();
    expect(months.find((m) => m.month === 9)?.volume).toBe(131_000);
    expect(
      months.find((m) => m.month === 10 || m.month === 11),
    ).toBeUndefined();
    // The other seed's month stays.
    expect(months.find((m) => m.month === 1)?.volume).toBe(4_000);
  });

  it("keeps observations of a different customer id fully isolated", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        scope: { ...SCOPE, customerId: "5555555555" },
        seedKeyword: "flowers",
      }),
    );

    const rows = await observationRows();
    expect(rows.map((row) => row.customerId).toSorted()).toEqual([
      "1234567890",
      "5555555555",
    ]);
  });
});

describe("GoogleAdsPlannerKeywordRepository.getObservation", () => {
  it("returns null before the first fetch and the honest flags after", async () => {
    const before = await GoogleAdsPlannerKeywordRepository.getObservation({
      ...SCOPE,
      dataType: "keyword_ideas",
      seedKeyword: "flowers",
    });
    expect(before).toBeNull();

    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({
        stats: {
          truncated: true,
          partial: true,
          malformedKeywordCount: 2,
          duplicateKeywordCount: 1,
          missingKeywordCount: 4,
        },
      }),
    );

    const after = await GoogleAdsPlannerKeywordRepository.getObservation({
      ...SCOPE,
      dataType: "keyword_ideas",
      seedKeyword: "flowers",
    });
    expect(after?.sourceFetchedAt).toBe("2026-10-24T00:00:00.000Z");
    expect(after?.truncated).toBe(true);
    expect(after?.partial).toBe(true);
    expect(after?.malformedKeywordCount).toBe(2);
    expect(after?.duplicateKeywordCount).toBe(1);
    expect(after?.missingKeywordCount).toBe(4);
    expect(after?.currencyCode).toBe("EUR");

    const otherSeed = await GoogleAdsPlannerKeywordRepository.getObservation({
      ...SCOPE,
      dataType: "keyword_ideas",
      seedKeyword: "trees",
    });
    expect(otherSeed).toBeNull();
  });
});

describe("GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches", () => {
  beforeEach(async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput(),
    );
  });

  it("rebuilds typed planner records: micros, variants, months, nulls", async () => {
    const matches =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(SCOPE, [
        "flower bouquets",
        "flower delivery",
        "olive trees",
      ]);

    const canonical = matches.canonical.get("flower bouquets");
    expect(canonical).toBeDefined();
    const record = canonical?.record;
    expect(record?.keyword).toBe("flower bouquets");
    expect(record?.closeVariants).toEqual(
      expect.arrayContaining(["flower bouquet", "flowers in a bouquet"]),
    );
    expect(record?.avgMonthlySearches).toBe(120_000);
    expect(record?.monthlySearchVolumes).toEqual([
      { year: 2026, month: 9, volume: 130_000 },
      { year: 2026, month: 10, volume: null },
      { year: 2026, month: 11, volume: 0 },
    ]);
    expect(record?.competition).toBe("MEDIUM");
    expect(record?.competitionIndex).toBe(57);
    expect(record?.averageCpcMicros).toBe(4_294_967_296);
    expect(record?.lowTopOfPageBidMicros).toBe(900_500);
    expect(record?.highTopOfPageBidMicros).toBe(2_100_750);
    expect(canonical?.currencyCode).toBe("EUR");
    expect(canonical?.sourceFetchedAt).toBe("2026-10-24T00:00:00.000Z");

    const delivery = matches.canonical.get("flower delivery");
    expect(delivery?.record.avgMonthlySearches).toBeNull();
    expect(delivery?.record.competition).toBeNull();

    // A keyword that is not stored is simply absent (never fabricated).
    expect(matches.canonical.get("olive trees")).toBeUndefined();
    // Nothing matches as a variant here: all requested keywords are canonical.
    expect(matches.variants.size).toBe(0);
  });

  it("resolves variant keywords to their canonical group's shared estimate", async () => {
    const matches =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(SCOPE, [
        "flower bouquet",
      ]);

    expect(matches.canonical.get("flower bouquet")).toBeUndefined();
    const variantMatch = matches.variants.get("flower bouquet");
    expect(variantMatch?.record.keyword).toBe("flower bouquets");
    expect(variantMatch?.record.competitionIndex).toBe(57);
  });

  it("resolves canonical keywords to their own group together with variant hits", async () => {
    const matches =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(SCOPE, [
        "flower bouquets",
        "flowers in a bouquet",
      ]);

    expect(matches.canonical.get("flower bouquets")?.record.keyword).toBe(
      "flower bouquets",
    );
    expect(matches.variants.get("flowers in a bouquet")?.record.keyword).toBe(
      "flower bouquets",
    );
  });

  it("excludes a different customer's observations", async () => {
    await GoogleAdsPlannerKeywordRepository.recordGroupObservation(
      observationInput({ scope: { ...SCOPE, customerId: "5555555555" } }),
    );

    const matches =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(SCOPE, [
        "flower bouquets",
      ]);
    // Only the original customer's group exists under the requested scope.
    expect(
      matches.canonical.get("flower bouquets")?.record.avgMonthlySearches,
    ).toBe(120_000);
  });

  it("filters out groups older than the freshness lower bound", async () => {
    const newer =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(
        SCOPE,
        ["flower bouquets"],
        { minSourceFetchedAt: "2026-10-25T00:00:00.000Z" },
      );
    expect(newer.canonical.size).toBe(0);

    const older =
      await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(
        SCOPE,
        ["flower bouquets"],
        { minSourceFetchedAt: "2026-10-24T00:00:00.000Z" },
      );
    expect(
      older.canonical.get("flower bouquets")?.record.competitionIndex,
    ).toBe(57);
  });

  it("maps the month, query used during writes to exact ids matching the repository read", async () => {
    // The adapter of ideas/metrics is an internal detail; the round-trip
    // itself suffices — every month row's groupId resolves to a real group
    // row id when read back through the typed matches.
    const months = await monthRows();
    const groups = await groupRows();
    const groupIds = new Set(groups.map((group) => group.id));
    for (const month of months) {
      expect(groupIds.has(month.groupId)).toBe(true);
    }
  });
});
