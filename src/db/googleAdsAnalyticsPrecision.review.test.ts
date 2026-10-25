import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  googleAdsDailyAccount,
  googleAdsDailyAdGroup,
  googleAdsDailyCampaign,
  googleAdsDailyDevice,
  googleAdsDailyKeyword,
  googleAdsDailyLandingPage,
  googleAdsDailySearchTerm,
} from "./pg/google-ads-analytics.schema";

// Google Ads integer metrics are int64, including cost in micros. A signed
// 32-bit PG integer overflows at only 2,147.483647 account currency units.
// Google conversions and conversion value are DOUBLE; PG real is float32.
// These structural checks complement the generic dialect-agnostic parity
// suite; they do not claim execution against a PostgreSQL database.
// https://www.postgresql.org/docs/current/datatype-numeric.html
const grains = [
  ["account", googleAdsDailyAccount],
  ["campaign", googleAdsDailyCampaign],
  ["ad_group", googleAdsDailyAdGroup],
  ["keyword", googleAdsDailyKeyword],
  ["search_term", googleAdsDailySearchTerm],
  ["device", googleAdsDailyDevice],
  ["landing_page", googleAdsDailyLandingPage],
] as const;

describe.each(grains)(
  "Google Ads %s PostgreSQL metric capacity",
  (_grain, table) => {
    it("can store safe int64 counts and cost above the 32-bit limit", () => {
      const columns = getTableColumns(table);
      for (const column of [
        columns.impressions,
        columns.clicks,
        columns.costMicros,
      ]) {
        expect(column.dataType).toBe("number");
        expect(column.getSQLType()).toMatch(/^(bigint|numeric(?:\(.*\))?)$/);
      }
    });

    it("preserves DOUBLE conversion and value precision", () => {
      const columns = getTableColumns(table);
      for (const column of [columns.conversions, columns.conversionsValue]) {
        expect(column.dataType).toBe("number");
        expect(column.getSQLType()).toMatch(
          /^(double precision|numeric(?:\(.*\))?)$/,
        );
      }
    });
  },
);
