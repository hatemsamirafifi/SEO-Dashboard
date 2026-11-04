# Local DataForSEO account queue migration — 2026-11-05

Migration `0077_dataforseo_account_request_slots.sql` was applied successfully to
the existing local Docker application. Existing projects, tracking configuration,
keywords, and ranking history were preserved. This adds a coordination table;
projects were not copied to another database or database provider.

## Target and backup

- Primary source folder: `F:/SEO-Dashboard`, bind-mounted at `/app` in
  `openseo-dev-app`.
- Application: `http://localhost:3101`; local D1/SQLite, binding `DB`, database
  `open-seo`, ID `37bee90a-e1aa-404f-b01e-b0d1d479bda1`.
- Active database:
  `/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/8776b4b8f1ef4325faa1c4edcc1d76726313abcd813c380a6b567bfe699b1f34.sqlite`.
- Recoverable backup outside the repository:
  `F:/SEO-Dashboard-backups/2026-11-05-004933/before.sqlite`.
- Backup size: **1,978,699,776 bytes**. Created using Python's SQLite online
  backup API inside the running container, checkpointed and closed before copying
  to the external backup folder. The backup was made before applying the migration.
- Full `PRAGMA integrity_check` on the consistent backup returned `ok`.
- Backup SHA-256, independently confirmed again on the external copy:
  `10750626c05b7eea1e83983d188ccea6124d85ffab830a959d1024f30594d8ba`.

The empty alternative `d1.sqlite`, Durable Object metadata database, and historical
`v3_backup` files were not used as the application database. No remote database or
unrelated Docker container was changed.

## Migration and preservation checks

Only `0077` was pending. Its SQL creates
`dataforseo_account_request_slots(account_hash, epoch, acquired_at, free_at)`;
it does not modify existing application tables. The migration ledger increased
from **80**, ending with `0076_indexnow_key.sql`, to **81**, ending with
`0077_dataforseo_account_request_slots.sql`.

The active table has the expected primary key, non-null columns and `epoch`
default of `1`. It contained zero rows during verification; no provider request
was dispatched to create a slot. Re-running local migration application and the
container's startup migration step both reported **No migrations to apply**.

The reviewer captured ordered row-content SHA-256 digests in a read transaction
before migration, against the consistent backup, after migration, and again after
the application restart. All eight tables matched exactly at every comparison.
The digest includes column order and JSON serialization of every row, ordered by
all columns; raw row contents are not included in this report.

| Table                    | Before | After restart | Content SHA-256                                                  |
| ------------------------ | -----: | ------------: | ---------------------------------------------------------------- |
| `projects`               |      5 |             5 | 611e23ca8a8b22f91b8f29d94996f05bb842e438f5097ecce8d55020213188b9 |
| `rank_tracking_configs`  |      4 |             4 | 58ce8b7077ddc941db3162a7c666a60db83650e8f6cb04f7259c91d4483b8f1b |
| `rank_tracking_keywords` |  1,903 |         1,903 | 7f9fa916923ff323aa009995b5adca42b47bfe597de86da50a8093a4ba685793 |
| `rank_check_runs`        |    169 |           169 | 4a2af9b8ca7968053affbcb9d2e0d81e121e033d413b5b8d24795be92c5d25a4 |
| `rank_snapshots`         |  9,755 |         9,755 | ca80ecc754a10d6d1ad1182f6308419ff29eda0ffb6071ba97922d42ead7b284 |
| `rank_provider_calls`    | 23,763 |        23,763 | 05e218357aa027822bc6dd4ff2d9c5201be7f9bcaa7c4e2669a41922b43dfbc0 |
| `saved_keywords`         |    219 |           219 | 1eb02a44b8e558cd705d1d5b1ccb800035d665b80359ede3111bcbdf24a34296 |
| `keyword_metrics`        |  4,581 |         4,581 | 274c82deb9e7cfd68860ccfa1da922b692c10091b050b6e0dcc5940f537e83fd |

Full `PRAGMA foreign_key_check` returned zero violations on the backup and on the
active database after migration. Independent focused checks after restart also
found zero configs without projects and zero tracking keywords without configs.
There were no active rank runs before restarting the application.

| Project ID prefix | Config ID prefix | Keywords before/after | Rows rendered in UI |
| ----------------- | ---------------- | --------------------: | ------------------: |
| `367587e1`        | `2971425d`       |                    98 |                  98 |
| `9012b88a`        | `bdb29d0b`       |                    16 |                  16 |
| `bb267736`        | `fe805117`       |                   878 |                 878 |
| `faf1d022`        | `a814adfd`       |                   911 |                 911 |

The fifth project has no tracking configuration; it remains present in the
projects list. The four configurations together retain all **1,903** tracking
keywords.

## Running application and source verification

Only `openseo-dev-app` was restarted. Docker records its new start time as
`2026-11-04T22:56:18.723623741Z` (2026-11-05 in Cairo). Startup applied no additional
migrations. Vite's cold startup took about 179 seconds; initial requests timed
out while its module graph loaded, then `/`, `/projects`, and `/settings` returned
HTTP 200.

Independent headless Chrome verification then confirmed:

- All five project cards rendered.
- The rank-tracking list rendered for each of the five projects.
- All four discovered tracking detail pages rendered the expected keyword rows:
  **98, 16, 878 and 911**.
- No JavaScript page errors, missing-configuration message or generic application
  error was observed in that verification.
- A separate read-only check of the 98-keyword configuration waited for its
  historical position-distribution chart to finish loading: HTTP 200, one chart
  SVG, eight rendered area paths, all 98 keyword rows, and zero JavaScript page
  errors.

The browser loaded the application once, then used client navigation for the
remaining views. HTTP 200 is an HTTP smoke check, separate from the rendered-data
checks above. Screenshots and the aggregate browser results were retained outside
the repository in the task's local temporary evidence folder.

The reviewer compared **all 2,293 tracked files** between the Windows primary
folder and `/app`, before adding this report: zero SHA-256 mismatches. The 33 files
in feature commit `a080085fe82df962196baf7387dbf9f20acb4a8c` also matched. Existing
uncommitted `src/routeTree.gen.ts` contents were preserved byte-for-byte; this is
not a claim that every file equals Git HEAD.

`pnpm-lock.yaml` and the installed `node_modules/.pnpm/lock.yaml` both have SHA-256
`ce4d27e14ecc67e3155edc95b052d83e0db725e1cd34a5913e2b2ff82d72718b`.
No dependency installation or product-code change was necessary for this
operational migration.

## Commands and test scope

Commands executed against this local application included:

```text
docker exec -w /app openseo-dev-app pnpm exec wrangler d1 migrations list DB --local
docker exec -w /app openseo-dev-app pnpm exec wrangler d1 migrations apply DB --local
docker restart openseo-dev-app
```

SQLite backup, integrity, foreign-key and ordered-digest verification used
temporary Python scripts. Backup copies and temporary scripts are not committed.

The reviewer independently re-ran these focused tests: **5 files, 49 tests passed**.

```text
pnpm exec vitest run src/db/dataforseoAccountGateMigration.test.ts src/shared/rank-tracking.test.ts src/server/features/rank-tracking/services/dataforseoAccountGate.test.ts src/server/features/rank-tracking/services/dataforseoAccountGateValidation.test.ts src/server/workflows/rankCheckPaths.test.ts --reporter=dot
```

The underlying feature had previously passed its broader 615-test verification
and type checking. The full repository gates were not repeated for this
documentation-only operational follow-up.

## Limits and execution record

No paid SERP request, rank-check button or remote migration was triggered.
Provider availability and whether DataForSEO has lifted any account pause were
not tested. Existing failed-run banners and unavailable historical rankings
remain part of the preserved data; adding this coordination table does not
change a previous run's result or lift a provider-side pause.

OpenCode, using the user-approved `opencode/glm-5.3-flash-free`, performed the
backup, migration, restart and its checks. Its free usage limit was reached after
those operations, before it wrote the operational report. The orchestrating
reviewer wrote this report from the execution outputs and independent
verification described above. No alternative model was selected.
