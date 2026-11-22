#!/usr/bin/env node
/**
 * Fail-safe local D1 migration guard for OpenSEO Docker & local development.
 *
 * Policy:
 * - Ordinary startup MUST NOT silently apply new SQL migrations to the active
 *   local D1 database.
 * - Read-only inspection compares `drizzle/*.sql` (and `drizzle/meta/_journal.json`)
 *   against the applied `d1_migrations` table in the active local SQLite DB.
 * - When all required migrations are already applied, exits 0 so the app and
 *   scheduler start normally without invoking Wrangler migrations.
 * - When pending migrations exist (or the local DB is uninitialized), exits 1
 *   with explicit operator guidance UNLESS `OPENSEO_ALLOW_AUTO_MIGRATE=true` is
 *   explicitly set (and `--check` was not passed).
 * - Never performs destructive SQL or automatic database resets.
 */
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");
const DEFAULT_D1_STATE_DIR = path.resolve(
  process.cwd(),
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
);

/**
 * Locate the active local D1 SQLite database file, ignoring metadata,
 * placeholder, backup, and staging files.
 */
export function findLocalD1Database(stateDir = DEFAULT_D1_STATE_DIR) {
  if (!fs.existsSync(stateDir)) {
    return null;
  }

  const candidateFiles = fs.readdirSync(stateDir).filter((f) => {
    if (!f.endsWith(".sqlite")) return false;
    if (f === "d1.sqlite" || f === "metadata.sqlite") return false;
    if (f.includes(".backup") || f.includes(".staging")) return false;
    return true;
  });

  if (candidateFiles.length === 0) {
    return null;
  }

  candidateFiles.sort((a, b) => {
    const sizeA = fs.statSync(path.join(stateDir, a)).size;
    const sizeB = fs.statSync(path.join(stateDir, b)).size;
    return sizeB - sizeA;
  });

  return path.join(stateDir, candidateFiles[0]);
}

/**
 * Verify that `drizzle/*.sql` files match `drizzle/meta/_journal.json` so
 * Drizzle and Wrangler migration journals stay consistent.
 */
export function checkDrizzleJournalConsistency(
  drizzleDir = DEFAULT_DRIZZLE_DIR,
) {
  if (!fs.existsSync(drizzleDir)) {
    return {
      ok: false,
      diskMigrations: [],
      journalMigrations: [],
      missingFromJournal: [],
      missingFromDisk: [],
      error: `Drizzle directory not found: ${drizzleDir}`,
    };
  }

  const diskMigrations = fs
    .readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return {
      ok: false,
      diskMigrations,
      journalMigrations: [],
      missingFromJournal: diskMigrations,
      missingFromDisk: [],
      error: `Drizzle migration journal not found: ${journalPath}`,
    };
  }

  const rawJournal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = Array.isArray(rawJournal?.entries) ? rawJournal.entries : [];
  const journalMigrations = entries.map((entry) => `${entry.tag}.sql`).sort();

  const diskSet = new Set(diskMigrations);
  const journalSet = new Set(journalMigrations);

  const missingFromJournal = diskMigrations.filter((f) => !journalSet.has(f));
  const missingFromDisk = journalMigrations.filter((f) => !diskSet.has(f));

  return {
    ok: missingFromJournal.length === 0 && missingFromDisk.length === 0,
    diskMigrations,
    journalMigrations,
    missingFromJournal,
    missingFromDisk,
    error: null,
  };
}

/**
 * Strictly read-only inspection of local D1 migration state.
 */
export function inspectLocalD1Migrations(options = {}) {
  const drizzleDir = options.drizzleDir ?? DEFAULT_DRIZZLE_DIR;
  const stateDir = options.stateDir ?? DEFAULT_D1_STATE_DIR;
  const dbPath =
    options.dbPath !== undefined
      ? options.dbPath
      : findLocalD1Database(stateDir);

  const journal = checkDrizzleJournalConsistency(drizzleDir);

  if (!dbPath || !fs.existsSync(dbPath)) {
    return {
      dbPath: dbPath ?? null,
      dbExists: false,
      hasMigrationsTable: false,
      journal,
      appliedMigrations: [],
      pendingMigrations: journal.diskMigrations,
      latestApplied: null,
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
      )
      .get();

    if (!tableRow) {
      return {
        dbPath,
        dbExists: true,
        hasMigrationsTable: false,
        journal,
        appliedMigrations: [],
        pendingMigrations: journal.diskMigrations,
        latestApplied: null,
      };
    }

    const rows = db
      .prepare("SELECT id, name, applied_at FROM d1_migrations ORDER BY id ASC")
      .all();

    const appliedMigrations = rows.map((r) => String(r.name));
    const appliedSet = new Set(appliedMigrations);
    const pendingMigrations = journal.diskMigrations.filter(
      (file) => !appliedSet.has(file),
    );
    const latestApplied =
      appliedMigrations.length > 0
        ? appliedMigrations[appliedMigrations.length - 1]
        : null;

    return {
      dbPath,
      dbExists: true,
      hasMigrationsTable: true,
      journal,
      appliedMigrations,
      pendingMigrations,
      latestApplied,
    };
  } finally {
    db.close();
  }
}

function defaultApplyLocalMigrations() {
  const result = spawnSync("pnpm", ["run", "db:migrate:local"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

/**
 * Enforce the explicit, fail-safe migration policy.
 */
export function runMigrationGuard(options = {}) {
  const allowAutoMigrate = Boolean(options.allowAutoMigrate);
  const checkOnly = Boolean(options.checkOnly);
  const logger = options.logger ?? console;
  const applyFn = options.applyFn ?? defaultApplyLocalMigrations;

  const inspection = inspectLocalD1Migrations({
    drizzleDir: options.drizzleDir,
    stateDir: options.stateDir,
    dbPath: options.dbPath,
  });

  if (!inspection.journal.ok) {
    logger.error(
      "[db-migration-guard] BLOCKED: Drizzle migration journal inconsistency detected.",
    );
    if (inspection.journal.error) {
      logger.error(`[db-migration-guard] ${inspection.journal.error}`);
    }
    if (inspection.journal.missingFromJournal.length > 0) {
      logger.error(
        `[db-migration-guard] SQL files missing from drizzle/meta/_journal.json: ${inspection.journal.missingFromJournal.join(", ")}`,
      );
    }
    if (inspection.journal.missingFromDisk.length > 0) {
      logger.error(
        `[db-migration-guard] Journal entries missing SQL files on disk: ${inspection.journal.missingFromDisk.join(", ")}`,
      );
    }
    logger.error(
      "[db-migration-guard] Fix journal consistency before applying migrations. See docs/operations/local-d1-migration-safety.md.",
    );
    return { exitCode: 1, status: "journal_mismatch", inspection };
  }

  if (
    inspection.dbExists &&
    inspection.hasMigrationsTable &&
    inspection.pendingMigrations.length === 0
  ) {
    logger.log(
      `[db-migration-guard] OK: All ${inspection.journal.diskMigrations.length} local D1 migrations are already applied (latest: ${inspection.latestApplied}). Starting without running migrations.`,
    );
    return { exitCode: 0, status: "up_to_date", inspection };
  }

  const reason = !inspection.dbExists
    ? "No active local D1 database file was found."
    : !inspection.hasMigrationsTable
      ? "Local D1 database does not have a d1_migrations table yet."
      : `${inspection.pendingMigrations.length} pending local D1 migration(s) detected: ${inspection.pendingMigrations.join(", ")}`;

  if (checkOnly || !allowAutoMigrate) {
    logger.error(`[db-migration-guard] BLOCKED: ${reason}`);
    logger.error(
      "[db-migration-guard] Automatic schema migrations on startup are DISABLED by policy to protect active local D1 data.",
    );
    logger.error("[db-migration-guard] Safe operator sequence:");
    logger.error(
      "  1. Back up the active database:  node scripts/backup-local-db.mjs",
    );
    logger.error(
      "  2. Rehearse on a disposable DB:  see docs/operations/local-d1-migration-safety.md",
    );
    logger.error(
      "  3. Explicitly apply migrations:  pnpm run db:migrate:local",
    );
    logger.error(
      "     (or one-shot Docker boot):    OPENSEO_ALLOW_AUTO_MIGRATE=true docker compose -f compose.dev.yaml up",
    );
    return {
      exitCode: 1,
      status: !inspection.dbExists
        ? "uninitialized_blocked"
        : "pending_blocked",
      inspection,
    };
  }

  logger.log(
    `[db-migration-guard] Explicit operator approval detected (OPENSEO_ALLOW_AUTO_MIGRATE=true). ${reason}`,
  );
  logger.log(
    "[db-migration-guard] Applying local D1 migrations via `pnpm run db:migrate:local`...",
  );

  const applyCode = applyFn();
  if (applyCode !== 0) {
    logger.error(
      `[db-migration-guard] Migration command failed with exit code ${applyCode}. Refusing to start application.`,
    );
    return { exitCode: applyCode, status: "apply_failed", inspection };
  }

  logger.log("[db-migration-guard] Local D1 migrations applied successfully.");
  return { exitCode: 0, status: "applied", inspection };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");
  const allowAutoMigrate = process.env.OPENSEO_ALLOW_AUTO_MIGRATE === "true";

  const result = runMigrationGuard({
    allowAutoMigrate,
    checkOnly,
  });
  process.exit(result.exitCode);
}
