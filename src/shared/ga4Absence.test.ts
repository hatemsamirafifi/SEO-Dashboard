import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * final-plan §9.4: `active28DayUsers` is excluded from the MVP entirely —
 * no column, no contract, no UI. Enforced at string level across the GA4
 * surface. (A metric identifier like this cannot legitimately appear in
 * prose comments either, so a raw full-file scan is the reliable guard.)
 */
const GA4_SURFACE_FILES = [
  "src/shared/ga4.ts",
  "src/server/lib/ga4Client.ts",
  "src/server/features/ga4/services/Ga4Service.ts",
  "src/types/schemas/ga4.ts",
  "src/serverFunctions/ga4.ts",
];

describe("GA4 active28DayUsers absence", () => {
  it("never appears in any GA4 contract, client, or service file", () => {
    for (const file of GA4_SURFACE_FILES) {
      const content = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(
        content.includes("active28DayUsers"),
        `${file} must not contain active28DayUsers`,
      ).toBe(false);
    }
  });
});
