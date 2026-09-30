/** Frozen `SerpSnapshot` contract fixtures (spec 003, G4). Both a full
 *  snapshot (all feature families) and a sparse snapshot (half families
 *  absent) must validate; absent families stay absent — never fabricated,
 *  never null-coerced empties. */
import { describe, expect, it } from "vitest";
import {
  canonicalSerpSnapshot,
  serpSnapshotIdentityKey,
  serpSnapshotSchema,
} from "./types";

function organicItem(
  position: number,
  overrides: Partial<{
    title: string;
    url: string;
    domain: string;
    featureRefs: string[];
  }> = {},
) {
  return {
    position,
    title: overrides.title ?? `Result ${position}`,
    url: overrides.url ?? `https://example.com/page-${position}`,
    domain: overrides.domain ?? "example.com",
    resultType: "organic",
    featureRefs: overrides.featureRefs ?? [],
  };
}

function fullSnapshotFixture() {
  return {
    keyword: "seo dashboard",
    engine: "google",
    location: {
      locationCode: 2840,
      locationName: "United States",
      countryCode: "US",
    },
    language: "en",
    device: "desktop",
    checkedAt: "2026-09-28T12:00:00.000Z",
    providerSnapshotAt: "2026-09-28T11:59:41.000Z",
    organicResults: [
      organicItem(1, {
        featureRefs: ["featured_result", "sitelinks"],
        url: "https://competitor.example/overview",
        domain: "competitor.example",
        title: "Overview — Competitor",
      }),
      organicItem(2, { featureRefs: ["local_pack"] }),
      organicItem(3),
    ],
    features: {
      featuredResult: {
        title: "Featured answer",
        url: "https://competitor.example/overview",
        domain: "competitor.example",
        snippet: "A featured snippet summary.",
      },
      peopleAlsoAsk: {
        items: [
          {
            question: "What is an SEO dashboard?",
            url: "https://example.com/faq",
            placement: null,
          },
        ],
      },
      relatedSearches: {
        items: ["seo software", "seo tools"],
      },
      localPack: {
        items: [
          {
            title: "Local Agency",
            url: "https://agency.example",
            domain: "agency.example",
            address: "1 Main St",
            rating: null,
            reviewCount: null,
          },
        ],
      },
      images: {
        items: [{ url: "https://img.example/1", title: null, domain: null }],
      },
      videos: {
        items: [{ url: "https://video.example/1", title: null, domain: null }],
      },
      shopping: {
        items: [
          {
            title: "SEO Tool",
            url: "https://shop.example/1",
            domain: "shop.example",
            price: "$99",
          },
        ],
      },
      news: {
        items: [
          {
            title: "News item",
            url: "https://news.example/1",
            domain: "news.example",
            sourceName: "News Daily",
            publishedAt: null,
          },
        ],
      },
      knowledgeGraph: {
        title: "SEO",
        url: "https://en.wikipedia.org/wiki/Search_engine_optimization",
        domain: "en.wikipedia.org",
        description: "Search engine optimization overview.",
      },
      sitelinks: {
        items: [
          {
            url: "https://competitor.example/pricing",
            domain: "competitor.example",
            title: "Pricing",
          },
        ],
      },
    },
    provider: "dataforseo",
    providerStatus: "success",
    contentHash: null,
  };
}

/** Sparse fixture: exactly five of the ten families present. */
function sparseSnapshotFixture() {
  const fixture = fullSnapshotFixture();
  fixture.organicResults = [organicItem(1)];
  fixture.features = {
    peopleAlsoAsk: {
      items: [{ question: "What is SEO?", url: null, placement: null }],
    },
    relatedSearches: {
      items: ["related seo"],
    },
    localPack: {
      items: [
        {
          title: "Agency",
          url: "https://agency.example",
          domain: "agency.example",
          address: null,
          rating: null,
        },
      ],
    },
    news: {
      items: [
        {
          title: "Item",
          url: "https://news.example/1",
          domain: "news.example",
          sourceName: null,
          publishedAt: null,
        },
      ],
    },
    sitelinks: {
      items: [
        {
          url: "https://competitor.example/pricing",
          domain: "competitor.example",
          title: "Pricing",
        },
      ],
    },
  } as never;
  return fixture;
}

describe("SerpSnapshot contract validation", () => {
  it("validates the full fixture across all feature families", () => {
    const parsed = serpSnapshotSchema.parse(fullSnapshotFixture());
    expect(parsed.features.featuredResult?.domain).toBe("competitor.example");
    expect(parsed.features.peopleAlsoAsk?.items).toHaveLength(1);
    expect(parsed.features.localPack?.items[0]?.title).toBe("Local Agency");
    expect(parsed.features.sitelinks?.items[0]?.url).toContain("pricing");
  });

  it("validates the sparse fixture with absent families as absent", () => {
    const fixture = sparseSnapshotFixture();
    const parsed = serpSnapshotSchema.parse(fixture);
    expect(parsed.features.featuredResult).toBeUndefined();
    expect(parsed.features.images).toBeUndefined();
    expect(parsed.features.videos).toBeUndefined();
    expect(parsed.features.shopping).toBeUndefined();
    expect(parsed.features.knowledgeGraph).toBeUndefined();
    // Present families keep payloads.
    expect(parsed.features.peopleAlsoAsk?.items).toHaveLength(1);
    expect(parsed.features.localPack?.items[0]?.title).toBe("Agency");
  });

  it("rejects date-only checkedAt (full ISO required)", () => {
    const fixture = fullSnapshotFixture();
    const broken = { ...fixture, checkedAt: "2026-09-28" };
    expect(() => serpSnapshotSchema.parse(broken)).toThrow();
  });

  it("rejects null-coerced empty claims (absent, not null)", () => {
    const fixture = fullSnapshotFixture();
    const coerced = { ...fixture, features: { featuredResult: null } };
    expect(() => serpSnapshotSchema.parse(coerced)).toThrow();
  });

  it("rejects unknown device values", () => {
    const fixture = fullSnapshotFixture();
    const broken = { ...fixture, device: "tablet" };
    expect(() => serpSnapshotSchema.parse(broken)).toThrow();
  });

  it("rejects non-positive organic positions", () => {
    const fixture = fullSnapshotFixture();
    const broken = {
      ...fixture,
      organicResults: [organicItem(0)],
    };
    expect(() => serpSnapshotSchema.parse(broken)).toThrow();
  });

  it("canonicalizes identity dimensions via canonicalSerpSnapshot", () => {
    const fixture = fullSnapshotFixture();
    const messy = {
      ...fixture,
      keyword: "  SEO Dashboard  ",
      engine: "GOOGLE",
      device: "Desktop",
      language: "EN",
    };
    const parsed = canonicalSerpSnapshot(messy);
    expect(parsed.keyword).toBe("SEO Dashboard");
    expect(parsed.engine).toBe("google");
    expect(parsed.device).toBe("desktop");
    expect(parsed.language).toBe("en");
    expect(parsed.location.locationCode).toBe(2840);
  });

  it("builds a logical identity key excluding provider and projectId", () => {
    const base = canonicalSerpSnapshot(fullSnapshotFixture());
    const withProviderA = { ...base, provider: "dataforseo" };
    const withProviderB = { ...base, provider: "serper" };
    expect(serpSnapshotIdentityKey(withProviderA)).toBe(
      serpSnapshotIdentityKey(withProviderB),
    );
    const tenanted = { ...base, projectId: "p1" };
    expect(serpSnapshotIdentityKey(tenanted)).toBe(
      serpSnapshotIdentityKey(base),
    );
  });

  it("distinguishes same-day snapshots by full checkedAt", () => {
    const base = canonicalSerpSnapshot(fullSnapshotFixture());
    const later = {
      ...base,
      checkedAt: "2026-09-28T15:00:00.000Z",
    };
    expect(serpSnapshotIdentityKey(base)).not.toBe(
      serpSnapshotIdentityKey(later),
    );
  });

  it("keeps provider as provenance alongside providerStatus", () => {
    const parsed = serpSnapshotSchema.parse(fullSnapshotFixture());
    expect(parsed.provider).toBe("dataforseo");
    expect(parsed.providerStatus).toBe("success");
    expect(parsed.providerSnapshotAt).toBeTypeOf("string");
    expect(new Date(parsed.providerSnapshotAt).getTime()).not.toBeNaN();
  });
});