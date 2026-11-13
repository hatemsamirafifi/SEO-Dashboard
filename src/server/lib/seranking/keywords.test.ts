import { describe, it, expect, vi } from "vitest";
import type { SeRankingClient } from "./client";
import {
  getSimilarKeywords,
  getRelatedKeywords,
  getLongTailKeywords,
  getExportKeywords,
} from "./keywords";

describe("SE Ranking Keywords Endpoints", () => {
  const createMockClient = (responseData: unknown) => {
    const request = vi.fn().mockResolvedValue(responseData);
    return {
      request,
    } as unknown as SeRankingClient & { request: ReturnType<typeof vi.fn> };
  };

  it("calls /keywords/similar with UTF-8 Arabic keyword and source=eg", async () => {
    const mockClient = createMockClient({
      total: 1,
      keywords: [
        {
          keyword: "عطور رجالية",
          volume: 2400,
          cpc: 0.85,
          difficulty: 32,
          competition: 0.65,
          intents: ["C"],
        },
      ],
    });

    const items = await getSimilarKeywords(mockClient, {
      keyword: "عطور رجالية",
      source: "eg",
      limit: 150,
    });

    expect(mockClient.request).toHaveBeenCalledWith("/keywords/similar", {
      method: "GET",
      params: {
        keyword: "عطور رجالية",
        source: "eg",
        limit: 150,
        offset: undefined,
        sort: undefined,
        sort_order: undefined,
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0].keyword).toBe("عطور رجالية");
    expect(items[0].volume).toBe(2400);
    expect(items[0].intent).toBe("commercial");
  });

  it("calls /keywords/related with source=eg", async () => {
    const mockClient = createMockClient({
      total: 1,
      keywords: [
        {
          keyword: "عطور رجالية صيفية",
          volume: 720,
          difficulty: 20,
          intents: ["I"],
        },
      ],
    });

    const items = await getRelatedKeywords(mockClient, {
      keyword: "عطور رجالية",
      source: "eg",
      limit: 50,
    });

    expect(mockClient.request).toHaveBeenCalledWith("/keywords/related", {
      method: "GET",
      params: {
        keyword: "عطور رجالية",
        source: "eg",
        limit: 50,
        offset: undefined,
        sort: undefined,
        sort_order: undefined,
      },
    });

    expect(items[0].keyword).toBe("عطور رجالية صيفية");
    expect(items[0].intent).toBe("informational");
  });

  it("calls /keywords/longtail with source=eg", async () => {
    const mockClient = createMockClient({
      total: 1,
      keywords: [
        {
          keyword: "افضل عطور رجالية ثبات وفوحان",
          volume: 390,
          difficulty: 15,
          intents: ["C"],
        },
      ],
    });

    const items = await getLongTailKeywords(mockClient, {
      keyword: "عطور رجالية",
      source: "eg",
      limit: 50,
    });

    expect(mockClient.request).toHaveBeenCalledWith("/keywords/longtail", {
      method: "GET",
      params: {
        keyword: "عطور رجالية",
        source: "eg",
        limit: 50,
        offset: undefined,
        sort: undefined,
        sort_order: undefined,
      },
    });

    expect(items[0].keyword).toBe("افضل عطور رجالية ثبات وفوحان");
  });

  it("calls /keywords/export via POST with body and source=eg query", async () => {
    const mockClient = createMockClient([
      {
        keyword: "عطور رجالية",
        volume: 2400,
        cpc: 0.85,
        difficulty: 32,
        competition: 0.65,
        intents: ["C"],
      },
    ]);

    const items = await getExportKeywords(mockClient, {
      keywords: ["عطور رجالية"],
      source: "eg",
    });

    expect(mockClient.request).toHaveBeenCalledWith("/keywords/export", {
      method: "POST",
      params: { source: "eg" },
      body: {
        keywords: ["عطور رجالية"],
        sort: undefined,
        sort_order: undefined,
        history_from: undefined,
        history_to: undefined,
      },
    });

    expect(items[0].keyword).toBe("عطور رجالية");
    expect(items[0].volume).toBe(2400);
  });
});
