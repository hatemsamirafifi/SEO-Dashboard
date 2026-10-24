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
import { googleAdsConnections } from "@/db/schema";

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

import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnectionInput,
} from "./GoogleAdsConnectionRepository";

const MIGRATION = "drizzle/0064_google_ads_connections.sql";

function connection(
  overrides: Partial<GoogleAdsConnectionInput> = {},
): GoogleAdsConnectionInput {
  return {
    projectId: "project-1",
    organizationId: "org-a",
    customerId: "1234567890",
    loginCustomerId: null,
    customerDisplayName: "Example Customer",
    grantAccountId: "google-sub-1",
    connectedByUserId: "user-1",
    currencyCode: "USD",
    timeZone: "Europe/Lisbon",
    isTestAccount: false,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = ON");
  // Minimal parent fixtures: the migration only needs the referenced tables to
  // exist, the repositories only read `projects.organization_id`.
  await database.client.execute(
    "CREATE TABLE organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL
     )`,
  );
  const migration = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.client.execute(statement);
  }
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("DELETE FROM google_ads_connections");
  await database.client.execute("DELETE FROM projects");
  await database.client.execute("DELETE FROM organization");
  await database.client.execute(
    "INSERT INTO organization (id) VALUES ('org-a'), ('org-b')",
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id) VALUES
       ('project-1', 'org-a'),
       ('project-2', 'org-a'),
       ('project-3', 'org-b')`,
  );
});

afterAll(() => database.client?.close());

async function rowsForProject(projectId: string) {
  if (!database.db) throw new Error("Test database was not initialized");
  return database.db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId));
}

describe("GoogleAdsConnectionRepository", () => {
  it("stores a normalized mapping and generates the row id", async () => {
    const created = await GoogleAdsConnectionRepository.upsert(
      connection({ customerId: "123-456-7890" }),
    );

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.customerId).toBe("1234567890");
    expect(created.loginCustomerId).toBeNull();
    expect(created.organizationId).toBe("org-a");
    expect(created.grantAccountId).toBe("google-sub-1");
    expect(created.isTestAccount).toBe(false);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const stored = await GoogleAdsConnectionRepository.getByProjectId(
      "project-1",
      "org-a",
    );
    expect(stored?.id).toBe(created.id);
  });

  it("rejects a connection whose project belongs to another organization", async () => {
    await expect(
      GoogleAdsConnectionRepository.upsert(
        connection({ projectId: "project-1", organizationId: "org-b" }),
      ),
    ).rejects.toThrow(/does not belong to the organization/);

    expect(await rowsForProject("project-1")).toHaveLength(0);
  });

  it("never reassigns an existing mapping owned by another organization", async () => {
    if (!database.db) throw new Error("Test database was not initialized");
    // Stale mapping: the project was moved to org-a while the row still says
    // org-b. The conflict guard must refuse the update, not rewrite the row.
    await database.db.insert(googleAdsConnections).values({
      id: "stale-row",
      projectId: "project-1",
      organizationId: "org-b",
      customerId: "9999999999",
      loginCustomerId: null,
      customerDisplayName: "Stale Customer",
      grantAccountId: "google-sub-stale",
      connectedByUserId: "user-2",
      currencyCode: "EUR",
      timeZone: null,
      isTestAccount: false,
    });

    await expect(
      GoogleAdsConnectionRepository.upsert(
        connection({ grantAccountId: "google-sub-1" }),
      ),
    ).rejects.toThrow("Failed to upsert google_ads_connection");

    const rows = await rowsForProject("project-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "stale-row",
      organizationId: "org-b",
      customerId: "9999999999",
      grantAccountId: "google-sub-stale",
      connectedByUserId: "user-2",
    });
  });

  it("preserves createdAt and refreshes updatedAt on a same-organization update", async () => {
    if (!database.client || !database.db)
      throw new Error("Test database was not initialized");
    const created = await GoogleAdsConnectionRepository.upsert(connection());
    const sentinel = "2000-01-01T00:00:00.000Z";
    await database.client.execute(
      `UPDATE google_ads_connections
          SET created_at = '${sentinel}', updated_at = '${sentinel}'
        WHERE id = '${created.id}'`,
    );

    const updated = await GoogleAdsConnectionRepository.upsert(
      connection({ customerId: "5555555555" }),
    );

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(sentinel);
    expect(updated.updatedAt).not.toBe(sentinel);
    expect(updated.customerId).toBe("5555555555");
  });

  it("switches the selected customer for a project", async () => {
    await GoogleAdsConnectionRepository.upsert(
      connection({ customerId: "1111111111" }),
    );
    const switched = await GoogleAdsConnectionRepository.upsert(
      connection({ customerId: "2222222222", loginCustomerId: "333-333-3333" }),
    );

    expect(switched.customerId).toBe("2222222222");
    expect(switched.loginCustomerId).toBe("3333333333");

    const rows = await rowsForProject("project-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customerId).toBe("2222222222");
  });

  it("keeps distinct projects on distinct rows", async () => {
    await GoogleAdsConnectionRepository.upsert(
      connection({ projectId: "project-1", customerId: "1111111111" }),
    );
    await GoogleAdsConnectionRepository.upsert(
      connection({ projectId: "project-2", customerId: "2222222222" }),
    );

    expect(await rowsForProject("project-1")).toHaveLength(1);
    expect(await rowsForProject("project-2")).toHaveLength(1);
    const first = await GoogleAdsConnectionRepository.getByProjectId(
      "project-1",
      "org-a",
    );
    const second = await GoogleAdsConnectionRepository.getByProjectId(
      "project-2",
      "org-a",
    );
    expect(first?.customerId).toBe("1111111111");
    expect(second?.customerId).toBe("2222222222");
  });

  it("reads and deletes only inside the owning organization", async () => {
    await GoogleAdsConnectionRepository.upsert(connection());

    expect(
      await GoogleAdsConnectionRepository.getByProjectId("project-1", "org-b"),
    ).toBeNull();

    await GoogleAdsConnectionRepository.deleteByProjectId("project-1", "org-b");
    expect(await rowsForProject("project-1")).toHaveLength(1);

    await GoogleAdsConnectionRepository.deleteByProjectId("project-1", "org-a");
    expect(await rowsForProject("project-1")).toHaveLength(0);
  });

  it("detects a grant already used by another project of the same user", async () => {
    await GoogleAdsConnectionRepository.upsert(
      connection({ projectId: "project-1" }),
    );
    await GoogleAdsConnectionRepository.upsert(
      connection({ projectId: "project-2" }),
    );

    expect(
      await GoogleAdsConnectionRepository.existsForConnectorAccount(
        "user-1",
        "google-sub-1",
      ),
    ).toBe(true);
    expect(
      await GoogleAdsConnectionRepository.existsForConnectorAccount(
        "user-2",
        "google-sub-1",
      ),
    ).toBe(false);
    expect(
      await GoogleAdsConnectionRepository.existsForConnectorAccount(
        "user-1",
        "google-sub-other",
      ),
    ).toBe(false);
  });

  it("rejects a malformed customer id instead of storing it", async () => {
    await expect(
      GoogleAdsConnectionRepository.upsert(connection({ customerId: "12345" })),
    ).rejects.toThrow(/Invalid Google Ads customer id/);

    expect(await rowsForProject("project-1")).toHaveLength(0);
  });
});
