import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDrizzleJournalConsistency,
  inspectLocalD1Migrations,
  runMigrationGuard,
} from "../../scripts/local-d1-migration-guard.mjs";

const tempDirs: string[] = [];

function createTempFixture(options: {
  sqlFiles: string[];
  journalTags?: string[];
  appliedMigrations?: string[];
  createDb?: boolean;
  createMigrationsTable?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openseo-mig-guard-"));
  tempDirs.push(dir);

  const drizzleDir = path.join(dir, "drizzle");
  const metaDir = path.join(drizzleDir, "meta");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  for (const file of options.sqlFiles) {
    fs.writeFileSync(path.join(drizzleDir, file), "-- test migration\n");
  }

  const tags =
    options.journalTags ??
    options.sqlFiles.map((file) => file.replace(/\.sql$/, ""));
  fs.writeFileSync(
    path.join(metaDir, "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: tags.map((tag, idx) => ({ idx, tag })),
    }),
  );

  let dbPath: string | undefined;
  if (options.createDb !== false) {
    dbPath = path.join(stateDir, "test-active.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      if (options.createMigrationsTable !== false) {
        db.exec(`
          CREATE TABLE d1_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
          );
        `);
        const insert = db.prepare(
          "INSERT INTO d1_migrations (name) VALUES (?)",
        );
        for (const name of options.appliedMigrations ?? []) {
          insert.run(name);
        }
      }
    } finally {
      db.close();
    }
  }

  return { dir, drizzleDir, stateDir, dbPath };
}

function createSilentLogger() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    logger: {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Local D1 Migration Safety Guard", () => {
  it("allows normal startup without invoking migrations when all migrations are already applied", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0080_prev.sql", "0081_seo_action_plans.sql"],
      appliedMigrations: ["0080_prev.sql", "0081_seo_action_plans.sql"],
    });
    const applyFn = vi.fn(() => 0);
    const { logger, logs, errors } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: false,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("up_to_date");
    expect(applyFn).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("already applied");
  });

  it("blocks pending migrations on ordinary restart and prints safe operator guidance", () => {
    const fixture = createTempFixture({
      sqlFiles: [
        "0080_prev.sql",
        "0081_seo_action_plans.sql",
        "0082_future_change.sql",
      ],
      appliedMigrations: ["0080_prev.sql", "0081_seo_action_plans.sql"],
    });
    const applyFn = vi.fn(() => 0);
    const { logger, errors } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: false,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("pending_blocked");
    expect(result.inspection.pendingMigrations).toEqual([
      "0082_future_change.sql",
    ]);
    expect(applyFn).not.toHaveBeenCalled();
    const errText = errors.join("\n");
    expect(errText).toContain("0082_future_change.sql");
    expect(errText).toContain("node scripts/backup-local-db.mjs");
    expect(errText).toContain("pnpm run db:migrate:local");
  });

  it("invokes migrations only when operator explicitly sets allowAutoMigrate=true", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0081_seo_action_plans.sql", "0082_future_change.sql"],
      appliedMigrations: ["0081_seo_action_plans.sql"],
    });
    const applyFn = vi.fn(() => 0);
    const { logger } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: true,
      checkOnly: false,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("applied");
    expect(applyFn).toHaveBeenCalledTimes(1);
  });

  it("never applies migrations in --check mode even if allowAutoMigrate=true", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0081_seo_action_plans.sql", "0082_future_change.sql"],
      appliedMigrations: ["0081_seo_action_plans.sql"],
    });
    const applyFn = vi.fn(() => 0);
    const { logger } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: true,
      checkOnly: true,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("pending_blocked");
    expect(applyFn).not.toHaveBeenCalled();
  });

  it("blocks startup when Drizzle _journal.json diverges from drizzle/*.sql files", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0081_seo_action_plans.sql", "0082_untracked.sql"],
      journalTags: ["0081_seo_action_plans"],
      appliedMigrations: ["0081_seo_action_plans.sql"],
    });
    const applyFn = vi.fn(() => 0);
    const { logger, errors } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: true,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("journal_mismatch");
    expect(applyFn).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("0082_untracked.sql");
  });

  it("blocks uninitialized database startup without silently creating or resetting it", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0081_seo_action_plans.sql"],
      createDb: false,
    });
    const applyFn = vi.fn(() => 0);
    const { logger } = createSilentLogger();

    const result = runMigrationGuard({
      allowAutoMigrate: false,
      drizzleDir: fixture.drizzleDir,
      stateDir: fixture.stateDir,
      applyFn,
      logger,
    });

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("uninitialized_blocked");
    expect(applyFn).not.toHaveBeenCalled();
  });

  it("confirms repository drizzle/meta/_journal.json is consistent with drizzle/*.sql", () => {
    const journal = checkDrizzleJournalConsistency();
    expect(journal.ok).toBe(true);
    expect(journal.missingFromJournal).toEqual([]);
    expect(journal.missingFromDisk).toEqual([]);
    expect(journal.diskMigrations).toContain("0081_seo_action_plans.sql");
  });

  it("inspectLocalD1Migrations opens SQLite strictly read-only without mutating files", () => {
    const fixture = createTempFixture({
      sqlFiles: ["0081_seo_action_plans.sql"],
      appliedMigrations: ["0081_seo_action_plans.sql"],
    });
    const beforeStat = fs.statSync(fixture.dbPath!);
    const inspection = inspectLocalD1Migrations({
      drizzleDir: fixture.drizzleDir,
      dbPath: fixture.dbPath,
    });
    const afterStat = fs.statSync(fixture.dbPath!);

    expect(inspection.pendingMigrations).toEqual([]);
    expect(inspection.latestApplied).toBe("0081_seo_action_plans.sql");
    expect(afterStat.size).toBe(beforeStat.size);
  });
});
