/* eslint-disable max-lines -- enrichment matrix (selection/merge/value/errors/cache/trace) lives in one suite per the mandatory test matrix */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SEODataRequest } from "@/server/lib/seo-data";
import {
  competitiveMetricsSchema,
  enrichmentStatusOf,
  serpSnapshotSchema,
} from "./types";

const routeMock = vi.hoisted(() =>
  vi.fn<(request: SEODataRequest) => Promise<unknown>>(),
);
const staleMock = vi.hoisted(() =>
  vi.fn<(request: SEODataRequest) => Promise<unknown>>(),
);

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: vi.fn(() => ({ route: routeMock })),
  SeoCacheService: { getStale: staleMock },
}));

// oxlint-disable-next-line import/first -- mocked router must load before the service under test
import { enrichCompetitiveMetrics } from "./serpEnrichment";

const billingCustomer = {
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "team@example.com",
};

describe("competitive metrics contract (spec 007)", () => {
  it("derives row status from core metrics only", () => {
    expect(
      enrichmentStatusOf({
        domainRank: 45,
        pageRank: 38,
        referringDomains: 1200,
        backlinks: 5400,
      }),
    ).toBe("available");
    // Explicit zeros are present values, not missing ones.
    expect(
      enrichmentStatusOf({
        domainRank: 0,
        pageRank: 0,
        referringDomains: 0,
        backlinks: 0,
      }),
    ).toBe("available");
    expect(
      enrichmentStatusOf({
        domainRank: 45,
        pageRank: null,
        referringDomains: 1200,
        backlinks: null,
      }),
    ).toBe("partial");
    expect(
      enrichmentStatusOf({
        domainRank: null,
        pageRank: undefined,
        referringDomains: null,
        backlinks: undefined,
      }),
    ).toBe("unavailable");
  });

  it("accepts explicit zeros and rejects unknown metric names", () => {
    const parsed = competitiveMetricsSchema.parse({
      domainRank: 0,
      pageRank: 12,
      referringDomains: 0,
      backlinks: 3,
      estimatedTraffic: null,
      spamScore: null,
      status: "available",
      provider: "dataforseo",
    });
    expect(parsed.backlinks).toBe(3);
    expect(parsed.referringDomains).toBe(0);
    // Proprietary third-party metric names are not part of the vocabulary.
    expect(() =>
      competitiveMetricsSchema.parse({
        domainRank: 45,
        pageRank: 38,
        referringDomains: 1200,
        backlinks: 5400,
        status: "available",
        domainAuthority: 52,
      }),
    ).toThrow();
  });

  it("leaves the frozen snapshot shape untouched", () => {
    expect("competitiveMetrics" in serpSnapshotSchema.shape).toBe(false);
    expect("enrichment" in serpSnapshotSchema.shape).toBe(false);
  });
});

const RESULTS = [
  { position: 1, url: "https://www.alpha.com/guide", domain: "www.alpha.com" },
  { position: 2, url: "https://alpha.com/pricing", domain: "alpha.com" },
  { position: 3, url: "https://beta.io/", domain: "beta.io" },
  { position: 4, url: "http://gamma.dev/a", domain: "gamma.dev" },
  { position: 5, url: "not a url", domain: "" },
  { position: 6, url: "https://delta.org/x", domain: "delta.org" },
  { position: 7, url: "https://epsilon.net/x", domain: "epsilon.net" },
  { position: 8, url: "https://zeta.co/x", domain: "zeta.co" },
  { position: 9, url: "https://eta.ai/x", domain: "eta.ai" },
  { position: 10, url: "https://theta.blog/x", domain: "theta.blog" },
  { position: 11, url: "https://lambda.com/", domain: "lambda.com" },
];

const SUMMARY_BY_DOMAIN: Record<string, Record<string, number | null>> = {
  "alpha.com": {
    rank: 42,
    backlinks: 1200,
    referring_domains: 320,
    backlinks_spam_score: 5,
  },
  "beta.io": {
    rank: 61,
    backlinks: 0,
    referring_domains: 12,
    backlinks_spam_score: null,
  },
  "gamma.dev": {
    rank: 88,
    backlinks: 40,
    referring_domains: 9,
    backlinks_spam_score: 2,
  },
  "delta.org": {
    rank: 15,
    backlinks: 9000,
    referring_domains: 2100,
    backlinks_spam_score: 1,
  },
  "epsilon.net": {
    rank: 70,
    backlinks: 120,
    referring_domains: 44,
    backlinks_spam_score: null,
  },
  "zeta.co": {
    rank: 55,
    backlinks: 300,
    referring_domains: 90,
    backlinks_spam_score: 3,
  },
  // eta.ai returns nothing usable → unavailable.
  "eta.ai": {},
  "theta.blog": {
    rank: 99,
    backlinks: 7,
    referring_domains: 3,
    backlinks_spam_score: 0,
  },
};

// Deliberately scrambled order with slash variants — merge must key on
// normalized identity, never array position.
const DOMAIN_PAGES_BY_DOMAIN: Record<string, Array<Record<string, unknown>>> = {
  "alpha.com": [
    { page: "https://alpha.com/pricing/", rank: 38 },
    { page: "https://alpha.com/guide", rank: 51 },
  ],
  "beta.io": [{ page: "https://beta.io/", rank: 60 }],
  "gamma.dev": [],
  "delta.org": [],
  "epsilon.net": [],
  "zeta.co": [],
  "eta.ai": [],
  "theta.blog": [],
};

function routedCalls() {
  return routeMock.mock.calls.map(([request]) => request);
}

function routeCallsFor(backlinkCall: string) {
  return routedCalls().filter(
    (request) => request.constraints?.backlinkCall === backlinkCall,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  staleMock.mockResolvedValue(null);
  routeMock.mockImplementation(async (request: SEODataRequest) => {
    const domain = request.domain ?? "";
    const call = request.constraints?.backlinkCall;
    if (call === "domain_pages") {
      return {
        dataType: "competitive_metrics",
        provider: "dataforseo",
        data: { items: DOMAIN_PAGES_BY_DOMAIN[domain] ?? [] },
        fromCache: false,
        durationMs: 1,
      };
    }
    return {
      dataType: "competitive_metrics",
      provider: "dataforseo",
      data: SUMMARY_BY_DOMAIN[domain] ?? {},
      fromCache: false,
      durationMs: 1,
    };
  });
});

describe("Top-10 selection and identity merge (spec 007)", () => {
  it("enriches exactly the Top-10, one entry per unique URL", async () => {
    const result = await enrichCompetitiveMetrics({
      results: RESULTS,
      billingCustomer,
    });

    // 9 unique URL identities (alpha/guide and alpha/pricing are distinct
    // targets sharing one domain; garbage + position-11 excluded).
    expect(result.targets).toHaveLength(9);
    const byIdentity = Object.fromEntries(
      result.targets.map((entry) => [entry.target.identity, entry]),
    );
    expect(
      byIdentity["https://alpha.com/guide"]?.target.sourcePositions,
    ).toEqual([1]);
    expect(
      byIdentity["https://alpha.com/pricing"]?.target.sourcePositions,
    ).toEqual([2]);
    expect(byIdentity["https://lambda.com/"]).toBeUndefined();
    // Every routed call carries the enrichment contract, never a keyword.
    for (const request of routedCalls()) {
      expect(request.dataType).toBe("competitive_metrics");
      expect(request.keyword).toBeUndefined();
      expect(request.billingCustomer).toEqual(billingCustomer);
    }
    // Fetches dedupe by domain: one summary + one domain-pages call per
    // unique domain despite two alpha URLs.
    expect(routeCallsFor("summary")).toHaveLength(8);
    expect(routeCallsFor("domain_pages")).toHaveLength(8);
    expect(routedCalls().every((r) => r.domain !== "lambda.com")).toBe(true);
  });

  it("merges page rank by normalized identity, never position", async () => {
    const result = await enrichCompetitiveMetrics({
      results: RESULTS,
      billingCustomer,
    });
    const byIdentity = Object.fromEntries(
      result.targets.map((entry) => [entry.target.identity, entry]),
    );
    // Trailing-slash variant in provider data still matches the snapshot row,
    // and each URL keeps its own page rank (never shared across a domain).
    expect(byIdentity["https://alpha.com/pricing"]?.metrics.pageRank).toBe(38);
    expect(byIdentity["https://alpha.com/guide"]?.metrics.pageRank).toBe(51);
    expect(byIdentity["https://alpha.com/pricing"]?.metrics.domainRank).toBe(
      42,
    );
    expect(byIdentity["https://alpha.com/guide"]?.metrics.status).toBe(
      "available",
    );
    // Explicit provider zero renders 0 and still counts as available core.
    expect(byIdentity["https://beta.io/"]?.metrics.backlinks).toBe(0);
    expect(byIdentity["https://beta.io/"]?.metrics.status).toBe("available");
    // No usable data → unavailable, other targets unaffected.
    expect(byIdentity["https://eta.ai/x"]?.metrics.status).toBe("unavailable");
  });
});

function pausedError() {
  return Object.assign(
    new Error("DataForSEO task error (40201): temporarily paused access"),
    { code: "DATAFORSEO_ACCESS_PAUSED" },
  );
}

function billingError() {
  return Object.assign(new Error("DataForSEO task error (40200)"), {
    code: "CREDITS_UNAVAILABLE",
  });
}

describe("enrichment failure semantics (spec 007)", () => {
  it("marks every target failed on total failure without retrying", async () => {
    routeMock.mockRejectedValue(pausedError());
    const result = await enrichCompetitiveMetrics({
      results: RESULTS,
      billingCustomer,
    });
    expect(result.targets).toHaveLength(9);
    for (const entry of result.targets) {
      expect(entry.metrics.status).toBe("failed");
    }
    expect(result.accountBlocked).toBe("account_paused");
    // Exactly one attempt per leg per domain — permanent failures are never
    // blindly retried by the enrichment layer.
    expect(routeCallsFor("summary")).toHaveLength(8);
    expect(routeCallsFor("domain_pages")).toHaveLength(8);
  });

  it("keeps account-paused and billing failures distinct", async () => {
    routeMock.mockRejectedValue(billingError());
    const result = await enrichCompetitiveMetrics({
      results: RESULTS,
      billingCustomer,
    });
    expect(result.accountBlocked).toBe("billing");
    expect(
      result.targets.every((entry) => entry.metrics.status === "failed"),
    ).toBe(true);
  });

  it("degrades one failed target while others stay enriched", async () => {
    routeMock.mockImplementation(async (request: SEODataRequest) => {
      const domain = request.domain ?? "";
      if (domain === "gamma.dev") throw new Error("socket hang up");
      const call = request.constraints?.backlinkCall;
      if (call === "domain_pages") {
        return {
          dataType: "competitive_metrics",
          provider: "dataforseo",
          data: { items: DOMAIN_PAGES_BY_DOMAIN[domain] ?? [] },
          fromCache: false,
          durationMs: 1,
        };
      }
      return {
        dataType: "competitive_metrics",
        provider: "dataforseo",
        data: SUMMARY_BY_DOMAIN[domain] ?? {},
        fromCache: false,
        durationMs: 1,
      };
    });
    const result = await enrichCompetitiveMetrics({
      results: RESULTS,
      billingCustomer,
    });
    const byIdentity = Object.fromEntries(
      result.targets.map((entry) => [entry.target.identity, entry]),
    );
    // Transient failure is not an account block; other rows unaffected.
    expect(result.accountBlocked).toBeNull();
    expect(byIdentity["https://gamma.dev/a"]?.metrics.status).toBe("failed");
    expect(byIdentity["https://alpha.com/pricing"]?.metrics.status).toBe(
      "available",
    );
  });
});

describe("stale fallback on refresh failure (spec 007)", () => {
  const STALE_SUMMARY = {
    rank: 77,
    backlinks: 410,
    referring_domains: 95,
    backlinks_spam_score: 2,
  };

  it("serves stale values marked stale instead of zeroing on refresh failure", async () => {
    routeMock.mockImplementation(async (request: SEODataRequest) => {
      if (request.domain === "theta.blog") throw new Error("socket hang up");
      throw new Error("unexpected call");
    });
    staleMock.mockImplementation(async (request: SEODataRequest) => {
      if (
        request.domain === "theta.blog" &&
        request.constraints?.backlinkCall === "summary"
      ) {
        return { data: STALE_SUMMARY, key: "stale-key" };
      }
      return null;
    });
    const result = await enrichCompetitiveMetrics({
      results: [
        { position: 1, url: "https://theta.blog/x", domain: "theta.blog" },
      ],
      billingCustomer,
    });
    expect(result.targets).toHaveLength(1);
    const metrics = result.targets[0]?.metrics;
    expect(metrics?.status).toBe("failed");
    expect(metrics?.stale).toBe(true);
    // Previous values preserved — never zeroed, never fabricated.
    expect(metrics?.domainRank).toBe(77);
    expect(metrics?.backlinks).toBe(410);
    expect(metrics?.pageRank).toBeNull();
  });

  it("renders failed with nulls when no stale value exists", async () => {
    routeMock.mockRejectedValue(new Error("socket hang up"));
    staleMock.mockResolvedValue(null);
    const result = await enrichCompetitiveMetrics({
      results: [
        { position: 1, url: "https://theta.blog/x", domain: "theta.blog" },
      ],
      billingCustomer,
    });
    const metrics = result.targets[0]?.metrics;
    expect(metrics?.status).toBe("failed");
    expect(metrics?.stale ?? false).toBe(false);
    expect(metrics?.domainRank).toBeNull();
    expect(metrics?.backlinks).toBeNull();
  });
});

describe("cross-keyword cache reuse (spec 007)", () => {
  it("issues identical target requests across keywords with no keyword leakage", async () => {
    await enrichCompetitiveMetrics({
      results: [
        { position: 1, url: "https://alpha.com/guide", domain: "alpha.com" },
        { position: 2, url: "https://beta.io/", domain: "beta.io" },
      ],
      billingCustomer,
    });
    vi.clearAllMocks();
    await enrichCompetitiveMetrics({
      results: [
        { position: 1, url: "https://alpha.com/pricing", domain: "alpha.com" },
        { position: 5, url: "https://gamma.dev/a", domain: "gamma.dev" },
      ],
      billingCustomer,
    });
    const alphaSummary = routeCallsFor("summary").filter(
      (r) => r.domain === "alpha.com",
    );
    expect(alphaSummary).toHaveLength(1);
    // Same target identity regardless of keyword context: no keyword field,
    // same domain + backlinkCall + billing customer → same cache key, so the
    // second analysis reuses the first analysis's fresh entry.
    expect(alphaSummary[0]).toMatchObject({
      dataType: "competitive_metrics",
      domain: "alpha.com",
    });
    expect(alphaSummary[0]).not.toHaveProperty("keyword");
  });
});

describe("enrichment trace records (spec 007)", () => {
  it("emits one secret-free record per run with operation and outcome counts", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => {
        lines.push(String(message));
      });
    try {
      await enrichCompetitiveMetrics({
        results: RESULTS,
        billingCustomer,
      });
    } finally {
      spy.mockRestore();
    }
    const record = lines.find((line) => line.startsWith("[serp-enrichment]"));
    expect(record).toBeDefined();
    expect(record).toContain("op=serp_competitive_enrichment");
    expect(record).toContain("provider=dataforseo");
    expect(record).toContain("targets=9");
    expect(record).toContain("available=");
    // Secret-free: no URLs, keywords, or credential-shaped values.
    expect(record).not.toContain("alpha.com");
    expect(record).not.toContain("http");
  });
});
