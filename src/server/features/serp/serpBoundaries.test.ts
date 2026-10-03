/** SERP contract boundary guards (spec 003, FR-004; G4 evidence).
 *
 *  1. UI and detector code must consume only the normalized contract:
 *     no imports of raw provider payload types, no provider-specific
 *     parsing outside the resolver/provider seam (FR-004).
 *  2. Every `src/**.ts` file reference in the frozen discovery report
 *     resolves to a real file (SC-001 evidence).
 *  3. The contract metric vocabulary carries no proprietary third-party
 *     metric labels (DA/PA/DR/TF/CF are prohibited — P16/FR-005). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Raw provider payload tokens that must never appear outside the resolver
 *  seams (src/server/features/serp, DataForSEO client, router provider
 *  seam, MCP/Labs readers of provider payloads). */
const RAW_TOKEN_PATTERNS: Array<{ token: string; pattern: RegExp }> = [
  { token: "SerpLiveItem", pattern: /SerpLiveItem/ },
  { token: "DataforseoApiResponse", pattern: /DataforseoApiResponse/ },
];

/** UI (client) + detector surfaces that must touch normalized types only. */
const GUARDED_SURFACES = [
  "src/client",
  "src/server/features/intelligence/detectors",
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    const full = join(dir, entry);
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    else walkTsFiles(full, out);
  }
  return out;
}

describe("SERP no-raw-parsing boundary (FR-004)", () => {
  it("keeps raw provider tokens out of the UI and detector surface", () => {
    const violations: string[] = [];
    for (const surfaceDir of GUARDED_SURFACES) {
      const files = walkTsFiles(resolve(process.cwd(), surfaceDir));
      for (const file of files) {
        const rel = file.slice(process.cwd().length + 1).replaceAll("\\", "/");
        const content = readFileSync(file, "utf8");
        for (const { token, pattern } of RAW_TOKEN_PATTERNS) {
          if (pattern.test(content)) violations.push(`${rel}: ${token}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves every src file reference in the frozen discovery report", () => {
    const report = readFileSync(
      resolve(process.cwd(), "specs/003-serp-contract-discovery/research.md"),
      "utf8",
    );
    const references = new Set<string>();
    for (const match of report.matchAll(/`([^`]*src\/[^`\s]+\.ts)[^`]*`/g)) {
      const candidate = match[1].split(/\s|,/)[0].split(":")[0];
      if (candidate.startsWith("src/") && candidate.endsWith(".ts")) {
        references.add(candidate);
      }
    }
    expect(references.size).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const ref of references) {
      if (!existsSync(resolve(process.cwd(), ref))) missing.push(ref);
    }
    expect(missing).toEqual([]);
  });

  it("keeps raw SERP payload modules out of the UI surface (spec 011)", () => {
    const PAYLOAD_MODULE_PATTERN =
      /from\s+["']@\/(server\/lib\/dataforseo\/serp["']|server\/lib\/seo-data\/providers[^"']*|server\/features\/serp\/(httpProviders|resolverCore|providerResolver))["']/;
    const violations: string[] = [];
    for (const file of walkTsFiles(resolve(process.cwd(), "src/client"))) {
      const rel = file.slice(process.cwd().length + 1).replaceAll("\\", "/");
      const content = readFileSync(file, "utf8");
      if (PAYLOAD_MODULE_PATTERN.test(content)) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });

  it("declares SERP feature labels in exactly one module (spec 011)", () => {
    // The split-vocabulary pattern (per-surface FEATURE_* label maps) is
    // banned: labels live in featurePresentation.ts (SERP_FAMILY_LABELS) and
    // every surface imports them. Rank-tracking chips consolidate in T014.
    const violations: string[] = [];
    for (const file of walkTsFiles(resolve(process.cwd(), "src/client"))) {
      const rel = file.slice(process.cwd().length + 1).replaceAll("\\", "/");
      const content = readFileSync(file, "utf8");
      if (/FEATURE_SHORT_LABELS|FEATURE_TOOLTIPS/.test(content)) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the frozen contract vocabulary free of proprietary metrics (FR-005)", () => {
    const surfaces = [
      resolve(process.cwd(), "src/server/features/serp/types.ts"),
      resolve(
        process.cwd(),
        "specs/003-serp-contract-discovery/contracts/serp-snapshot.md",
      ),
      // Spec 007 additive surfaces: enrichment service, its contract, and
      // the expanded competitor row must use provider-accurate names only.
      resolve(process.cwd(), "src/server/features/serp/serpEnrichment.ts"),
      resolve(
        process.cwd(),
        "specs/007-serp-top10-enrichment/contracts/enrichment-api.md",
      ),
      resolve(
        process.cwd(),
        "src/client/features/keywords/components/SerpAnalysisCard.tsx",
      ),
    ];
    for (const surface of surfaces) {
      if (!existsSync(surface)) continue;
      const content = readFileSync(surface, "utf8");
      // Lines that NAME the ban (the prohibition clause itself) are exempt —
      // the guard exists so real metric labels never appear as usable
      // vocabulary, not to outlaw documenting the ban.
      const vocabularyOnly = content
        .split("\n")
        .filter(
          (line) =>
            !/PROHIBIT|prohibited|no DA\/PA\/DR\/TF\/CF|P16|Metric vocabulary/.test(
              line,
            ),
        )
        .join("\n");
      expect(vocabularyOnly).not.toMatch(/\bT[fr]{1,2}\b|\bC[fr]{1,2}\b/);
      expect(vocabularyOnly).not.toMatch(
        /\b(Domain Authority|Page Authority|Domain Rating)\b/,
      );
    }
  });
});
