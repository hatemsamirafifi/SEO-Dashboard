import type { Client } from "@libsql/client";
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
import { GOOGLE_ADS_OAUTH_SCOPES } from "@/shared/google-ads";

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
  GOOGLE_ADS_ADWORDS_SCOPE,
  GoogleAdsGrantRepository,
} from "./GoogleAdsGrantRepository";

// The better-auth `account` table is the grant store. Its shipped DDL is used
// verbatim instead of a hand-written copy, so this test reads the real column
// shape (provider_id, account_id, scope, ...).
const ACCOUNT_MIGRATION = "drizzle/0003_light_sage.sql";

function createTableStatement(table: string): string {
  const sql = readFileSync(resolve(process.cwd(), ACCOUNT_MIGRATION), "utf8");
  const statement = sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`CREATE TABLE \`${table}\``));
  if (!statement) throw new Error(`No CREATE TABLE found for ${table}`);
  return statement;
}

const ADS_SCOPE_LIST =
  "openid email profile https://www.googleapis.com/auth/adwords";

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  await database.client.execute(createTableStatement("account"));
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("DELETE FROM account");
  await database.client.execute(
    `INSERT INTO account
       (id, account_id, provider_id, user_id, access_token, scope, created_at, updated_at)
     VALUES
       ('acc-ads-1', 'google-sub-1', 'google-ads', 'user-1', 'secret-token-1',
        '${ADS_SCOPE_LIST}', 1, 1),
       ('acc-ads-2', 'google-sub-2', 'google-ads', 'user-1', 'secret-token-2',
        'https://www.googleapis.com/auth/adwords', 1, 1),
       ('acc-ads-other-user', 'google-sub-1', 'google-ads', 'user-2', 'secret-token-3',
        'openid', 1, 1),
       ('acc-ga4', 'google-sub-1', 'google-analytics', 'user-1', 'secret-token-4',
        'https://www.googleapis.com/auth/analytics.readonly', 1, 1)`,
  );
});

afterAll(() => database.client?.close());

describe("GoogleAdsGrantRepository", () => {
  it("lists only the google-ads grants of the given user", async () => {
    const grants = await GoogleAdsGrantRepository.listForUser("user-1");

    expect(grants).toHaveLength(2);
    expect(grants.map((grant) => grant.accountId).toSorted()).toEqual([
      "google-sub-1",
      "google-sub-2",
    ]);
  });

  it("exposes only the account id and the scope, never tokens", async () => {
    const grants = await GoogleAdsGrantRepository.listForUser("user-1");

    for (const grant of grants) {
      expect(Object.keys(grant).toSorted()).toEqual(["accountId", "scope"]);
    }
  });

  it("returns the grant owned by the requested user", async () => {
    const grant = await GoogleAdsGrantRepository.getOwnedGrant(
      "user-1",
      "google-sub-1",
    );

    expect(grant).toEqual({
      accountId: "google-sub-1",
      scope: ADS_SCOPE_LIST,
    });
  });

  it("does not return another provider's grant for the same sub", async () => {
    // user-1 owns `google-sub-1` for two providers; only the Ads grant is
    // visible through this repository.
    const grant = await GoogleAdsGrantRepository.getOwnedGrant(
      "user-1",
      "google-sub-1",
    );

    expect(grant?.scope).toBe(ADS_SCOPE_LIST);
    expect(grant?.scope).not.toContain("analytics");
  });

  it("separates the same OAuth sub connected by different users", async () => {
    const forUserTwo = await GoogleAdsGrantRepository.getOwnedGrant(
      "user-2",
      "google-sub-1",
    );
    const forUnknownUser = await GoogleAdsGrantRepository.getOwnedGrant(
      "user-3",
      "google-sub-1",
    );

    expect(forUserTwo).toEqual({ accountId: "google-sub-1", scope: "openid" });
    expect(forUnknownUser).toBeNull();
  });

  it("returns null for an unknown grant", async () => {
    expect(
      await GoogleAdsGrantRepository.getOwnedGrant("user-1", "unknown-sub"),
    ).toBeNull();
  });

  it("detects the adwords scope exactly", () => {
    expect(GoogleAdsGrantRepository.hasAdsConsent(ADS_SCOPE_LIST)).toBe(true);
    expect(
      GoogleAdsGrantRepository.hasAdsConsent(
        "openid,email,profile,https://www.googleapis.com/auth/adwords",
      ),
    ).toBe(true);
    expect(
      GoogleAdsGrantRepository.hasAdsConsent(
        "https://www.googleapis.com/auth/adwords",
      ),
    ).toBe(true);
    expect(
      GoogleAdsGrantRepository.hasAdsConsent(
        "https://www.googleapis.com/auth/adwords.readonly",
      ),
    ).toBe(false);
    expect(
      GoogleAdsGrantRepository.hasAdsConsent(
        "https://www.googleapis.com/auth/analytics.readonly",
      ),
    ).toBe(false);
    expect(GoogleAdsGrantRepository.hasAdsConsent("adwords")).toBe(false);
    expect(GoogleAdsGrantRepository.hasAdsConsent("")).toBe(false);
    expect(GoogleAdsGrantRepository.hasAdsConsent(null)).toBe(false);
  });

  it("checks a scope the OAuth provider actually requests", () => {
    expect(GOOGLE_ADS_OAUTH_SCOPES).toContain(GOOGLE_ADS_ADWORDS_SCOPE);
  });
});
