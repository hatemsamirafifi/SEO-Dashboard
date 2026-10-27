import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { researchKeywordsTool } from "./research-keywords";

describe("researchKeywordsTool schema validation", () => {
  const schema = z.object(researchKeywordsTool.config.inputSchema);

  it("accepts canonical seed objects", () => {
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: [{ seed: "sports turf", locationCode: 2818, languageCode: "ar" }],
    });
    expect(parsed.seeds).toEqual([
      { seed: "sports turf", locationCode: 2818, languageCode: "ar" },
    ]);
  });

  it("accepts plain strings for seeds", () => {
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: ["sports turf", "football court"],
    });
    expect(parsed.seeds).toEqual([
      { seed: "sports turf" },
      { seed: "football court" },
    ]);
  });

  it("accepts a single plain string for seeds", () => {
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: "sports turf",
    });
    expect(parsed.seeds).toEqual([{ seed: "sports turf" }]);
  });

  it("accepts objects using 'keyword' instead of 'seed'", () => {
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: [{ keyword: "padel court", locationCode: 2840 }],
    });
    expect(parsed.seeds).toEqual([
      { seed: "padel court", locationCode: 2840, languageCode: undefined },
    ]);
  });

  it("accepts objects using 'query' or 'term'", () => {
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: [{ query: "gym equipment" }, { term: "swimming pool" }],
    });
    expect(parsed.seeds).toEqual([
      {
        seed: "gym equipment",
        locationCode: undefined,
        languageCode: undefined,
      },
      {
        seed: "swimming pool",
        locationCode: undefined,
        languageCode: undefined,
      },
    ]);
  });

  it("slices seeds to max 20 when more than 20 are provided", () => {
    const manySeeds = Array.from({ length: 25 }, (_, i) => `seed-${i + 1}`);
    const parsed = schema.parse({
      projectId: "proj_123",
      seeds: manySeeds,
    });
    expect(parsed.seeds).toHaveLength(20);
    expect(parsed.seeds[0].seed).toBe("seed-1");
    expect(parsed.seeds[19].seed).toBe("seed-20");
  });

  it("accepts flexible resultLimit numbers and string representations", () => {
    expect(
      schema.parse({
        projectId: "proj_123",
        seeds: ["turf"],
        resultLimit: 50,
      }).resultLimit,
    ).toBe(50);

    expect(
      schema.parse({
        projectId: "proj_123",
        seeds: ["turf"],
        resultLimit: "150",
      }).resultLimit,
    ).toBe(150);

    expect(
      schema.parse({
        projectId: "proj_123",
        seeds: ["turf"],
        resultLimit: 300,
      }).resultLimit,
    ).toBe(300);
  });
});
