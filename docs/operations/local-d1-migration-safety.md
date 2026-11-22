# Local D1 Migration Safety, Verification, and Recovery Runbook

## Policy

OpenSEO local Docker development enforces a **fail-safe, explicit-approval migration policy** via `scripts/local-d1-migration-guard.mjs` and `docker-entrypoint.dev.sh`:

1. **No silent migrations on restart**: `OPENSEO_ALLOW_AUTO_MIGRATE` defaults to `false` in `compose.dev.yaml`. Ordinary `docker compose -f compose.dev.yaml up` or `docker restart` commands **never** invoke `wrangler d1 migrations apply`.
2. **Normal startup when up to date**: The guard opens the active local D1 SQLite database in strictly **read-only** mode (`DatabaseSync(..., { readOnly: true })`). When every `drizzle/*.sql` file is already recorded in `d1_migrations` and `drizzle/meta/_journal.json` is consistent, the guard exits `0` immediately and the app + scheduler start normally.
3. **Fail-fast detection of pending migrations**: If any new `drizzle/*.sql` file is unapplied (or if `drizzle/meta/_journal.json` diverges from `drizzle/*.sql`), startup halts with exit code `1` and prints exact operator instructions.
4. **No destructive schema resets**: The guard never drops tables, deletes `.wrangler/state`, or runs destructive SQL.
5. **Journal consistency**: Both Drizzle (`drizzle/meta/_journal.json`) and Wrangler (`d1_migrations`) are checked before any migration is permitted.

---

## Safe Operator Sequence

### 1. Check Current Migration Status (Read-Only)

```bash
pnpm run db:migrate:status
```

This performs a read-only check of `drizzle/*.sql`, `drizzle/meta/_journal.json`, and `d1_migrations` without modifying the database.

### 2. Back Up the Active Local D1 Database

Before applying any new migration, create an atomic, integrity-verified backup:

```bash
node scripts/backup-local-db.mjs
```

Record the output backup path and SHA-256 checksum. The backup script uses `VACUUM INTO` on a read-only connection and verifies both `PRAGMA integrity_check` and `PRAGMA quick_check`.

### 3. Rehearse on a Disposable Database Copy

Never test an unverified migration directly on `.wrangler/state`:

1. Copy the verified backup from `backups/d1-backup-<timestamp>.sqlite` into a temporary directory (for example, `/tmp/openseo-migration-rehearsal/`).
2. Apply the pending SQL migration(s) against the disposable copy only.
3. Verify on the disposable copy:
   - `PRAGMA integrity_check;` returns `ok`.
   - `PRAGMA foreign_key_check;` returns zero rows for affected tables.
   - Expected historical row counts (such as `rank_snapshots`, `sam_sessions`, `projects`) are preserved.
4. Remove the temporary rehearsal directory once verified.

### 4. Explicitly Activate and Apply the Migration

Once backed up and rehearsed, apply migrations explicitly using either:

- **Direct operator command (recommended)**:
  ```bash
  pnpm run db:migrate:local
  ```
- **Or one-shot Docker startup with explicit approval**:
  ```bash
  OPENSEO_ALLOW_AUTO_MIGRATE=true docker compose -f compose.dev.yaml up
  ```
  (Unset or leave `OPENSEO_ALLOW_AUTO_MIGRATE=false` for all subsequent normal restarts.)

### 5. Post-Migration Verification

1. Confirm read-only guard passes:
   ```bash
   pnpm run db:migrate:status
   ```
2. Verify applied migration row in `d1_migrations`, table existence, `PRAGMA foreign_key_check`, and preserved historical counts (e.g. `rank_snapshots`).
3. Verify the local app healthcheck (`/api/internal/cron/status`) returns HTTP `200` and the scheduled pilot configuration is unchanged.

### 6. Recovery / Rollback Procedure

If a migration causes unexpected behavior or failure:

1. Stop the local Docker services cleanly:
   ```bash
   docker compose -f compose.dev.yaml down
   ```
2. Verify the pre-migration backup integrity and SHA-256 checksum before restoring:
   ```bash
   sha256sum backups/d1-backup-<timestamp>.sqlite
   ```
3. Move the failed active SQLite file (and any `-wal`/`-shm` sidecar files) aside rather than deleting immediately:
   ```bash
   mv .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<active-db>.sqlite \
      .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<active-db>.sqlite.failed-$(date +%Y%m%d-%H%M%S)
   rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<active-db>.sqlite-wal \
         .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<active-db>.sqlite-shm
   ```
4. Copy the verified backup back into place:
   ```bash
   cp backups/d1-backup-<timestamp>.sqlite \
      .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<active-db>.sqlite
   ```
5. Revert the unapplied migration file/journal entry in git if you are rolling back code, verify `pnpm run db:migrate:status`, and restart with `docker compose -f compose.dev.yaml up`.
