import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as sqliteApp from "./app.schema";
import * as sqliteSam from "./sam.schema";
import * as sqliteAuth from "./better-auth-schema";
import * as sqliteBilling from "./billing.schema";
import * as sqliteGsc from "./gsc.schema";
import * as sqliteGa4 from "./ga4.schema";
import * as sqliteIntelligence from "./intelligence.schema";
import * as sqliteInsights from "./insights.schema";
import * as sqliteOpportunities from "./opportunities.schema";
import * as sqliteReports from "./reports.schema";
import * as sqliteReportSharing from "./report-sharing.schema";
import * as sqliteAutopilot from "./autopilot.schema";
import * as sqliteReddit from "./reddit-attribution.schema";
import * as sqliteTelemetry from "./telemetry.schema";
import * as pgApp from "./pg/app.schema";
import * as pgSam from "./pg/sam.schema";
import * as pgAuth from "./pg/better-auth-schema";
import * as pgBilling from "./pg/billing.schema";
import * as pgGsc from "./pg/gsc.schema";
import * as pgGa4 from "./pg/ga4.schema";
import * as pgIntelligence from "./pg/intelligence.schema";
import * as pgInsights from "./pg/insights.schema";
import * as pgOpportunities from "./pg/opportunities.schema";
import * as pgReports from "./pg/reports.schema";
import * as pgReportSharing from "./pg/report-sharing.schema";
import * as pgAutopilot from "./pg/autopilot.schema";
import * as pgReddit from "./pg/reddit-attribution.schema";
import * as pgTelemetry from "./pg/telemetry.schema";

// Guards the ONE structural artifact `db:generate` does not regenerate: the
// hand-written Postgres schema. The provider-aware `db`/`@/db/schema` barrel
// types Postgres as the SQLite schema via a cast, so these two schemas MUST stay
// structurally interchangeable or that cast lies. This test fails loudly the
// moment they drift (e.g. a table added to one dialect but not the other).

type Dialect = "sqlite" | "pg";

const sortStrings = (values: string[]) =>
  values.toSorted((a, b) => a.localeCompare(b));

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return sortStrings(value.filter((v): v is string => typeof v === "string"));
}

function tablesFrom(...modules: Record<string, unknown>[]) {
  const out = new Map<string, Table>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (is(value, Table)) out.set(getTableName(value), value);
    }
  }
  return out;
}

const getConfig = (table: Table, dialect: Dialect) =>
  dialect === "pg" ? getPgTableConfig(table) : getSqliteTableConfig(table);

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  hasDefault: boolean;
  enumValues: string[] | null;
};

function columnsOf(table: Table): ColumnInfo[] {
  return Object.values(getTableColumns(table)).map((col) => ({
    name: col.name,
    notNull: col.notNull,
    // `dataType` resolves to `any` via Drizzle's column config generic; narrow it.
    dataType: typeof col.dataType === "string" ? col.dataType : "unknown",
    hasDefault: col.hasDefault,
    enumValues: asStringArray(col.enumValues),
  }));
}

function columnName(candidate: unknown): string | null {
  if (
    candidate &&
    typeof candidate === "object" &&
    "name" in candidate &&
    typeof candidate.name === "string"
  ) {
    return candidate.name;
  }
  return null;
}

// Unique constraints reduced to "sortedCols[|partial]" — including whether the
// index carries a WHERE predicate so a partial→full change (which alters the
// onConflict invariant) is caught even though the predicate text is dialect-
// specific.
function uniqueColumnTuples(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  const tuples = new Set<string>();
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    const cols = index.config.columns
      .map(columnName)
      .filter((name): name is string => name !== null);
    tuples.add(
      sortStrings(cols).join(",") + (index.config.where ? "|partial" : ""),
    );
  }
  for (const constraint of config.uniqueConstraints) {
    tuples.add(sortStrings(constraint.columns.map((c) => c.name)).join(","));
  }
  for (const col of Object.values(getTableColumns(table))) {
    if (col.isUnique) tuples.add(col.name);
  }
  return sortStrings([...tuples]);
}

function primaryKeyColumns(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  const pk = new Set<string>();
  for (const col of Object.values(getTableColumns(table))) {
    if (col.primary) pk.add(col.name);
  }
  for (const composite of config.primaryKeys) {
    for (const col of composite.columns) pk.add(col.name);
  }
  return sortStrings([...pk]);
}

// FK as "cols->refTable.refCols onDelete=action" so a dropped/changed cascade is
// caught (the parity property repositories rely on for cascading deletes).
function foreignKeys(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  return sortStrings(
    config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      const cols = sortStrings(ref.columns.map((c) => c.name)).join(",");
      const refTable = getTableName(ref.foreignTable);
      const refCols = sortStrings(ref.foreignColumns.map((c) => c.name)).join(
        ",",
      );
      return `${cols}->${refTable}.${refCols} onDelete=${fk.onDelete ?? "none"}`;
    }),
  );
}

const sqliteAppTables = tablesFrom(
  sqliteApp,
  sqliteSam,
  sqliteBilling,
  sqliteGsc,
  sqliteGa4,
  sqliteIntelligence,
  sqliteInsights,
  sqliteOpportunities,
  sqliteReports,
  sqliteReportSharing,
  sqliteAutopilot,
  sqliteReddit,
  sqliteTelemetry,
);
const pgAppTables = tablesFrom(
  pgApp,
  pgSam,
  pgBilling,
  pgGsc,
  pgGa4,
  pgIntelligence,
  pgInsights,
  pgOpportunities,
  pgReports,
  pgReportSharing,
  pgAutopilot,
  pgReddit,
  pgTelemetry,
);
const sqliteAuthTables = tablesFrom(sqliteAuth);
const pgAuthTables = tablesFrom(pgAuth);

describe("schema parity: application tables", () => {
  it("define the same set of tables on both backends", () => {
    expect(sortStrings([...pgAppTables.keys()])).toEqual(
      sortStrings([...sqliteAppTables.keys()]),
    );
  });

  for (const [name, sqliteTable] of sqliteAppTables) {
    const pgTable = pgAppTables.get(name);
    if (!pgTable) continue; // reported by the table-set assertion above

    describe(`table "${name}"`, () => {
      it("has matching columns (name, nullability, type, default, enum)", () => {
        // dataType is dialect-agnostic ("string"/"number"/"boolean"/"date") so
        // text/text, boolean/boolean, serial/autoincrement match; a real type
        // mismatch is caught.
        expect(columnsOf(pgTable)).toEqual(columnsOf(sqliteTable));
      });
      it("has matching primary key", () => {
        expect(primaryKeyColumns(pgTable, "pg")).toEqual(
          primaryKeyColumns(sqliteTable, "sqlite"),
        );
      });
      it("has matching unique constraints (onConflict targets)", () => {
        expect(uniqueColumnTuples(pgTable, "pg")).toEqual(
          uniqueColumnTuples(sqliteTable, "sqlite"),
        );
      });
      it("has matching foreign keys (incl. onDelete)", () => {
        expect(foreignKeys(pgTable, "pg")).toEqual(
          foreignKeys(sqliteTable, "sqlite"),
        );
      });
    });
  }
});

describe("schema parity: better-auth tables", () => {
  // better-auth schemas are generated per-dialect (auth:generate) and are
  // intentionally dialect-native in column TYPE (SQLite integer-timestamp_ms /
  // text-json vs Postgres timestamptz / jsonb). So we assert structure that
  // MUST match — table set, column names, nullability, PK, unique constraints —
  // but not dataType. This catches a column/table added or removed on one
  // dialect but not the other (e.g. a stale-oauth-tables drift, or a
  // better-auth upgrade applied to only one schema).
  it("define the same set of tables on both backends", () => {
    expect(sortStrings([...pgAuthTables.keys()])).toEqual(
      sortStrings([...sqliteAuthTables.keys()]),
    );
  });

  for (const [name, sqliteTable] of sqliteAuthTables) {
    const pgTable = pgAuthTables.get(name);
    if (!pgTable) continue;

    describe(`table "${name}"`, () => {
      it("has matching column names + nullability", () => {
        const shape = (table: Table) =>
          Object.fromEntries(columnsOf(table).map((c) => [c.name, c.notNull]));
        expect(shape(pgTable)).toEqual(shape(sqliteTable));
      });
      it("has matching primary key", () => {
        expect(primaryKeyColumns(pgTable, "pg")).toEqual(
          primaryKeyColumns(sqliteTable, "sqlite"),
        );
      });
      it("has matching unique constraints", () => {
        expect(uniqueColumnTuples(pgTable, "pg")).toEqual(
          uniqueColumnTuples(sqliteTable, "sqlite"),
        );
      });
    });
  }
});

// Secondary indexes that better-auth's `generate` CLI does NOT emit — they are
// hand-added to both schema files for query performance. Running `auth:generate`
// overwrites the files and drops them, so this guard fails loudly (on either
// dialect) if a regen forgets to re-apply them. Columns are SQL column names.
const REQUIRED_BETTER_AUTH_INDEXES: {
  table: string;
  columns: string[];
  unique: boolean;
}[] = [
  { table: "session", columns: ["user_id"], unique: false },
  { table: "account", columns: ["user_id"], unique: false },
  { table: "account", columns: ["account_id", "provider_id"], unique: false },
  { table: "verification", columns: ["identifier"], unique: false },
  { table: "verification", columns: ["expires_at"], unique: false },
  { table: "organization", columns: ["slug"], unique: true },
  { table: "member", columns: ["organization_id"], unique: false },
  { table: "member", columns: ["user_id"], unique: false },
  { table: "invitation", columns: ["organization_id"], unique: false },
  { table: "invitation", columns: ["email"], unique: false },
];

function indexKeys(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  return config.indexes.map((index) => {
    const cols = index.config.columns
      .map(columnName)
      .filter((name): name is string => name !== null);
    return `${sortStrings(cols).join(",")}|${index.config.unique ? "unique" : "index"}`;
  });
}

describe("better-auth required indexes (CLI omits them; re-apply after auth:generate)", () => {
  for (const dialect of ["sqlite", "pg"] as const) {
    const tables = dialect === "pg" ? pgAuthTables : sqliteAuthTables;
    describe(dialect, () => {
      for (const req of REQUIRED_BETTER_AUTH_INDEXES) {
        const label = `${req.table}(${req.columns.join(",")})${req.unique ? " unique" : ""}`;
        it(`has index ${label}`, () => {
          const table = tables.get(req.table);
          expect(table, `missing table "${req.table}"`).toBeDefined();
          if (!table) return;
          const key = `${sortStrings(req.columns).join(",")}|${req.unique ? "unique" : "index"}`;
          expect(indexKeys(table, dialect)).toContain(key);
        });
      }
    });
  }
});

describe("spec 012: scheduled report tables (D2b)", () => {
  // TDD: fails until T004 adds reportSchedules + reportScheduleRuns to both
  // dialects. Column/index/unique/FK expectations quote data-model.md §1–2
  // verbatim so drift fails loudly here AND in the generic suite above.
  const sqliteByName = tablesFrom(sqliteReports);
  const pgByName = tablesFrom(pgReports);

  it("defines report_schedules and report_schedule_runs on both backends", () => {
    for (const name of ["report_schedules", "report_schedule_runs"]) {
      expect(sqliteByName.get(name), `sqlite missing ${name}`).toBeDefined();
      expect(pgByName.get(name), `pg missing ${name}`).toBeDefined();
    }
  });

  it("matches the spec'd report_schedules columns", () => {
    const table = sqliteByName.get("report_schedules");
    expect(table).toBeDefined();
    if (!table) return;
    expect(
      columnsOf(table)
        .map((c) => c.name)
        .toSorted(),
    ).toEqual(
      [
        "id",
        "project_id",
        "organization_id",
        "report_type",
        "cadence",
        "recipients",
        "share_id",
        "active",
        "paused_at",
        "next_due_at",
        "last_run_at",
        "created_by_user_id",
        "created_at",
        "updated_at",
      ].toSorted(),
    );
  });

  it("matches the spec'd report_schedule_runs columns", () => {
    const table = sqliteByName.get("report_schedule_runs");
    expect(table).toBeDefined();
    if (!table) return;
    expect(
      columnsOf(table)
        .map((c) => c.name)
        .toSorted(),
    ).toEqual(
      [
        "id",
        "schedule_id",
        "scheduled_for",
        "report_id",
        "state",
        "failure_class",
        "skip_reason",
        "recipient_outcomes",
        "claimed_at",
        "completed_at",
        "created_at",
        "updated_at",
      ].toSorted(),
    );
  });

  it("enforces UNIQUE(schedule_id, scheduled_for) on both backends (P33)", () => {
    for (const [dialect, table] of [
      ["sqlite", sqliteByName.get("report_schedule_runs")],
      ["pg", pgByName.get("report_schedule_runs")],
    ] as const) {
      expect(table, `${dialect} missing report_schedule_runs`).toBeDefined();
      if (!table) continue;
      const tuples = uniqueColumnTuples(table, dialect);
      expect(
        tuples.some(
          (t) => t.includes("schedule_id") && t.includes("scheduled_for"),
        ),
        `${dialect} tuples: ${tuples.join(" | ")}`,
      ).toBe(true);
    }
  });

  it("cascades schedule and run rows with their project (FK parity)", () => {
    const schedules = sqliteByName.get("report_schedules");
    const runs = sqliteByName.get("report_schedule_runs");
    expect(schedules).toBeDefined();
    expect(runs).toBeDefined();
    if (!schedules || !runs) return;
    expect(foreignKeys(schedules, "sqlite")).toContain(
      "project_id->projects.id onDelete=cascade",
    );
    expect(foreignKeys(runs, "sqlite")).toContain(
      "schedule_id->report_schedules.id onDelete=cascade",
    );
    expect(foreignKeys(runs, "sqlite")).toContain(
      "report_id->reports.id onDelete=cascade",
    );
  });
});

describe("no direct db.batch (must use runBatch)", () => {
  // `db.batch` only exists on the D1 driver; on Postgres it throws. All atomic
  // multi-statement writes must go through `runBatch`, which is the only file
  // allowed to call `.batch`.
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(path));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        out.push(path);
    }
    return out;
  }

  it("is not called outside src/db/runBatch.ts", () => {
    const offenders = walk("src")
      .filter((path) => !path.endsWith(join("db", "runBatch.ts")))
      .filter((path) => /\.batch\(/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  }, 30000);
});
