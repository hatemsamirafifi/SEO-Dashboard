import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(
  () =>
    new Map<
      string,
      { body: string; customMetadata?: Record<string, string> }
    >(),
);

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        return {
          text: async () => entry.body,
          customMetadata: entry.customMetadata ?? {},
        };
      },
      put: async (
        key: string,
        body: string,
        options?: { customMetadata?: Record<string, string> },
      ) => {
        store.set(key, { body, customMetadata: options?.customMetadata });
      },
    },
  },
}));

import { getCached, getStaleCached, setCached } from "./r2-cache";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  store.clear();
});

describe("r2-cache expiry semantics (spec 007 freshness boundaries)", () => {
  it("serves entries inside their TTL", async () => {
    await setCached("k-fresh", { v: 1 }, 30 * 86400);
    expect(await getCached("k-fresh")).toEqual({ v: 1 });
  });

  it("hides entries past their expiry but keeps them for stale reads", async () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    store.set("dataforseo-cache/k-stale", {
      body: JSON.stringify({ v: 2 }),
      customMetadata: { expiresAt: expiredAt },
    });
    expect(await getCached("k-stale")).toBeNull();
    expect(await getStaleCached("k-stale")).toEqual({ v: 2 });
  });

  it("stale reads miss on absent keys and corrupt JSON", async () => {
    expect(await getStaleCached("k-missing")).toBeNull();
    store.set("dataforseo-cache/k-corrupt", {
      body: "not-json{{{",
      customMetadata: {},
    });
    expect(await getStaleCached("k-corrupt")).toBeNull();
    expect(await getCached("k-corrupt")).toBeNull();
  });

  it("writes expiresAt metadata from the TTL", async () => {
    const before = Date.now();
    await setCached("k-meta", { v: 3 }, 30 * 86400);
    const entry = store.get("dataforseo-cache/k-meta");
    const expiresAt = Date.parse(entry?.customMetadata?.expiresAt ?? "");
    expect(expiresAt).toBeGreaterThan(before + 29 * DAY_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS + 5000);
  });
});
