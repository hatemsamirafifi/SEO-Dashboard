import { beforeEach, expect, it, vi } from "vitest";
import type { SEODataRequest } from "@/server/lib/seo-data";
import {
  backlinksHistoryItemSchema,
  backlinksSummaryItemSchema,
  backlinksItemSchema,
  referringDomainItemSchema,
  domainPageSummaryItemSchema,
} from "@/server/lib/dataforseo/backlinks-schemas";

const routeMock = vi.hoisted(() =>
  vi.fn<(request: SEODataRequest, schema?: unknown) => Promise<unknown>>(),
);

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: vi.fn(() => ({ route: routeMock })),
}));

vi.mock("@/server/lib/dataforseo", () => ({
  normalizeBacklinksTarget: vi.fn(),
  backlinksHistoryItemSchema,
  backlinksSummaryItemSchema,
  backlinksItemSchema,
  referringDomainItemSchema,
  domainPageSummaryItemSchema,
}));

import { normalizeBacklinksTarget } from "@/server/lib/dataforseo";
import { createBacklinksService } from "./BacklinksService";

const BACKLINK_CALLS = [
  "summary",
  "history",
  "rows",
  "referring_domains",
  "domain_pages",
] as const;

const billingCustomer = {
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "team@example.com",
};

const pageInputDefaults = {
  projectId: "project_123",
  page: 1,
  pageSize: 100,
  sortOrder: "desc",
  filters: {},
  mode: "as_is",
} as const;

const service = createBacklinksService();

beforeEach(() => {
  vi.clearAllMocks();
});

function routerResponse(data: unknown, fromCache = false) {
  return {
    dataType: "backlinks",
    provider: "dataforseo",
    data,
    fromCache,
    durationMs: 1,
  };
}

function routedCalls() {
  return routeMock.mock.calls.map(([request]) => request);
}

function routeCallsFor(backlinkCall: (typeof BACKLINK_CALLS)[number]) {
  return routedCalls().filter(
    (request) => request.constraints?.backlinkCall === backlinkCall,
  );
}

function mockTarget(apiTarget: string, scope: "domain" | "page") {
  vi.mocked(normalizeBacklinksTarget).mockReturnValue({
    apiTarget,
    displayTarget: apiTarget,
    scope,
  });
}

it("profiles referring domains and top pages pages separately", async () => {
  mockTarget("https://example.com/foo", "page");
  routeMock.mockImplementation(async (request) =>
    request.constraints?.backlinkCall === "referring_domains"
      ? routerResponse({
          items: [
            {
              domain: "source.example",
              backlinks: 4,
              referring_pages: 2,
              rank: 65,
              first_seen: "2026-01-01",
              broken_backlinks: 0,
              broken_pages: 0,
              backlinks_spam_score: 2,
              target_spam_score: 4,
            },
          ],
          totalCount: 1,
        })
      : routerResponse({
          items: [
            {
              page: "https://example.com/foo",
              backlinks: 100,
              referring_domains: 20,
              rank: 50,
              broken_backlinks: 0,
            },
          ],
          totalCount: 1,
        }),
  );

  const domains = await service.profileReferringDomainsPage(
    {
      ...pageInputDefaults,
      target: "https://example.com/foo",
      sortField: "backlinks",
    },
    billingCustomer,
  );
  const pages = await service.profileTopPagesPage(
    {
      ...pageInputDefaults,
      target: "https://example.com/foo",
      sortField: "backlinks",
    },
    billingCustomer,
  );

  expect(routeCallsFor("referring_domains")).toHaveLength(1);
  expect(routeCallsFor("domain_pages")).toHaveLength(1);
  expect(domains.rows).toHaveLength(1);
  expect(domains.rows[0]?.spamScore).toBe(2);
  expect(domains.hasMore).toBe(false);
  expect(pages.rows).toHaveLength(1);
  expect(pages.rows[0]?.page).toBe("https://example.com/foo");
});

it("does not fall back to target spam score for referring domains", async () => {
  mockTarget("example.com", "domain");
  routeMock.mockResolvedValue(
    routerResponse({
      items: [
        {
          domain: "source.example",
          backlinks: 4,
          referring_pages: 2,
          rank: 65,
          first_seen: "2026-01-01",
          broken_backlinks: 0,
          broken_pages: 0,
          backlinks_spam_score: null,
          target_spam_score: 4,
        },
      ],
      totalCount: 1,
    }),
  );

  const domains = await service.profileReferringDomainsPage(
    {
      ...pageInputDefaults,
      target: "example.com",
      sortField: "backlinks",
    },
    billingCustomer,
  );

  expect(domains.rows).toHaveLength(1);
  expect(domains.rows[0]?.spamScore).toBeNull();
});

it("hands each distinct request shape to the router without a service-side cache", async () => {
  mockTarget("example.com", "domain");
  routeMock.mockResolvedValue(routerResponse({ items: [], totalCount: 0 }));

  const input = {
    ...pageInputDefaults,
    target: "example.com",
    sortField: "rank",
  } as const;

  await service.profileBacklinksPage(input, billingCustomer);
  await service.profileBacklinksPage({ ...input, page: 2 }, billingCustomer);
  await service.profileBacklinksPage(input, {
    organizationId: "org_456",
    userId: "user_456",
    userEmail: "other@example.com",
  });

  // Keyed by {org, constraints}: page 2 differs by offset, the third call by
  // organizationId. The router owns caching — the service never dedupes.
  expect(routeMock).toHaveBeenCalledTimes(3);
  const [first, second, third] = routeMock.mock.calls.map(
    ([request]) => request,
  );
  expect(first.constraints?.offset).toBe(0);
  expect(second.constraints?.offset).toBe(100);
  expect(first.billingCustomer.organizationId).toBe("org_123");
  expect(third.billingCustomer.organizationId).toBe("org_456");
});
