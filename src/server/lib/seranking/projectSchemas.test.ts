import { describe, expect, it } from "vitest";
import type { SeRankingPositionItem } from "./projectSchemas";
import { extractPositionObservation } from "./projectParsers";

describe("extractPositionObservation - Distinguish Checked-But-Not-Ranked from Awaiting Crawl", () => {
  it("treats pos: 0 with depth: 100 as genuine checked-but-not-ranked (observed: true, position: null)", () => {
    const item = {
      normalizedKeywordId: "25105687",
      normalizedKeyword: "ترتان صناعي",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-15",
          pos: 0,
          depth: 100,
          change: 0,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(true);
    expect(obs.position).toBeNull();
    expect(obs.observedDate).toBe("2026-11-15");
    expect(obs.providerChange).toBe(0);
  });

  it("treats positive rank with depth: 100 as checked-and-ranked (observed: true, position: 44)", () => {
    const item = {
      normalizedKeywordId: "25105684",
      normalizedKeyword: "تكلفة ملعب خماسي",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-15",
          pos: 44,
          depth: 100,
          change: 0,
          landing_page: "https://sports-ms.com/cost",
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(true);
    expect(obs.position).toBe(44);
    expect(obs.url).toBe("https://sports-ms.com/cost");
    expect(obs.observedDate).toBe("2026-11-15");
  });

  it("treats newly provisioned keyword with pos: 0 but depth: 0 as awaiting crawl (observed: false)", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "keyword awaiting first crawl",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-15",
          pos: 0,
          depth: 0, // No depth inspected yet
          change: 0,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("treats newly provisioned keyword with is_checked: 0 as awaiting crawl (observed: false)", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "keyword not checked yet",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-15",
          pos: 0,
          is_checked: 0,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("treats newly provisioned keyword with pos: null as awaiting crawl (observed: false)", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "keyword with null pos",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-15",
          pos: null,
          depth: 100,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("treats empty positions array as awaiting crawl (observed: false)", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "brand new keyword",
      serpFeaturesList: [],
      positions: [],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("treats missing target date in positions array as awaiting crawl for that date (observed: false)", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "keyword checked yesterday only",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-14",
          pos: 50,
          depth: 100,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("Engine has check date 2026-11-15 but keyword positions array does not contain it: NOT NO_RESULT (observed: false)", () => {
    // Engine check dates endpoint reports 2026-11-15 is available, but this specific keyword
    // was not included in that crawl. It must remain observed: false (PENDING), NEVER NO_RESULT.
    const item = {
      normalizedKeywordId: "25105688",
      normalizedKeyword: "uncrawled keyword",
      serpFeaturesList: [],
      positions: [
        {
          date: "2026-11-13",
          pos: 20,
          depth: 100,
        },
      ],
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
    expect(obs.observedDate).toBeNull();
  });

  it("Keyword missing completely from positions response: does not produce NO_RESULT (observed: false)", () => {
    // When a keyword is not present in GET /sites/positions, it is never passed to extractPositionObservation,
    // but if an empty placeholder item is evaluated, observed must be false.
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "missing keyword",
      serpFeaturesList: [],
      positions: undefined,
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
    expect(obs.position).toBeNull();
  });

  it("handles record/object positions format and distinguishes depth: 0", () => {
    const item = {
      normalizedKeywordId: "99999999",
      normalizedKeyword: "record format test",
      serpFeaturesList: [],
      positions: {
        "2026-11-15": {
          pos: 0,
          depth: 0,
        },
      },
    } as unknown as SeRankingPositionItem;

    const obs = extractPositionObservation(item, "2026-11-15");
    expect(obs.observed).toBe(false);
  });
});
