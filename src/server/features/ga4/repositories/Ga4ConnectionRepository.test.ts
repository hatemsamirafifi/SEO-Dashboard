import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ga4Connections } from "@/db/schema";

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

import { Ga4ConnectionRepository } from "./Ga4ConnectionRepository";

const connection = {
  projectId: "shared-project",
  organizationId: "organization-a",
  propertyId: "property-a",
  propertyDisplayName: "Property A",
  connectedByUserId: "user-a",
  ga4AccountId: "account-a",
  currencyCode: "USD",
  hasEcommerce: false,
};

describe("Ga4ConnectionRepository conflict isolation", () => {
  beforeEach(async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute("DROP TABLE IF EXISTS ga4_connections");
    await database.client.execute(`
      CREATE TABLE ga4_connections (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        property_display_name TEXT NOT NULL,
        connected_by_user_id TEXT NOT NULL,
        ga4_account_id TEXT NOT NULL,
        currency_code TEXT,
        has_ecommerce INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (current_timestamp),
        updated_at TEXT NOT NULL DEFAULT (current_timestamp)
      )
    `);
  });

  afterAll(() => database.client?.close());

  it("cannot reassign another organization's project mapping through an upsert conflict", async () => {
    await Ga4ConnectionRepository.upsert(connection);

    await expect(
      Ga4ConnectionRepository.upsert({
        ...connection,
        organizationId: "organization-b",
        propertyId: "property-b",
        propertyDisplayName: "Property B",
        connectedByUserId: "user-b",
        ga4AccountId: "account-b",
      }),
    ).rejects.toThrow("Failed to upsert ga4_connection");

    if (!database.db) throw new Error("Test database was not initialized");
    const rows = await database.db
      .select()
      .from(ga4Connections)
      .where(eq(ga4Connections.projectId, "shared-project"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "organization-a",
      propertyId: "property-a",
      connectedByUserId: "user-a",
      ga4AccountId: "account-a",
    });
  });

  it("latches ecommerce capability and currency without touching the mapping", async () => {
    const created = await Ga4ConnectionRepository.upsert(connection);
    await Ga4ConnectionRepository.updateConnectionCapabilities(created.id, {
      hasEcommerce: true,
      currencyCode: "EUR",
    });

    if (!database.db) throw new Error("Test database was not initialized");
    const rows = await database.db
      .select()
      .from(ga4Connections)
      .where(eq(ga4Connections.projectId, "shared-project"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      propertyId: "property-a",
      hasEcommerce: true,
      currencyCode: "EUR",
    });
  });
});
