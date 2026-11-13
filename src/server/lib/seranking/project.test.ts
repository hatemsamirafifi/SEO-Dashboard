import { describe, expect, it, vi } from "vitest";
import { SeRankingProjectService } from "./project";
import {
  SeRankingAuthError,
  SeRankingCreditExhaustedError,
  SeRankingNotFoundError,
  SeRankingRateLimitError,
  SeRankingUpstreamError,
} from "./errors";
import { AppError } from "@/server/lib/errors";
import type { SeRankingClient } from "./client";

describe("SeRankingProjectService - Quota Separation & Anti-Automation Payloads", () => {
  it("never queries Data API /account/subscription and reports unknown limits honestly when caps are omitted", async () => {
    const requestedPaths: string[] = [];
    const client = {
      request: vi.fn(async (path: string) => {
        requestedPaths.push(path);
        if (path === "/project-management/users/me") {
          return { id: 99, email: "team@example.com" };
        }
        if (path === "/project-management/sites") {
          return [
            {
              id: 101,
              title: "Site A",
              url: "https://a.com",
              keyword_count: 15,
            },
            {
              id: 102,
              title: "Site B",
              url: "https://b.com",
              keyword_count: 25,
            },
          ];
        }
        if (path === "/account/subscription") {
          return { status: "expired", units_limit: 1000, units_left: 0 };
        }
        return [];
      }),
    } as unknown as SeRankingClient;

    const report = await SeRankingProjectService.validateAccessAndQuota(client);

    expect(requestedPaths).not.toContain("/account/subscription");
    expect(report.apiAuth).toEqual({
      status: "ok",
      source: "users_me",
      accountEmail: "team@example.com",
    });
    expect(report.projectApi.accessible).toBe(true);
    expect(report.projectSubscription.status).toBe("active");
    expect(report.projectCapacity).toMatchObject({
      status: "unknown",
      limit: "unknown",
      used: 2,
      remaining: "unknown",
      source: "inferred_from_sites",
    });
    expect(report.trackedKeywordCapacity).toMatchObject({
      status: "unknown",
      limit: "unknown",
      used: 40,
      remaining: "unknown",
      source: "inferred_from_sites",
    });
    expect(report.deviceLocationAllocations.status).toBe("unknown");
    expect(report.recheckRestrictions.status).toBe("unknown");
  });

  it("uses verified provider limits when /users/me reports them and separates 401/403/402/429 failures", async () => {
    const clientWithLimits = {
      request: vi.fn(async (path: string) => {
        if (path === "/project-management/users/me") {
          return { sites_limit: 10, keywords_limit: 500 };
        }
        if (path === "/project-management/sites") {
          return [
            { id: 1, title: "One", url: "https://one.com", keyword_count: 120 },
          ];
        }
        return [];
      }),
    } as unknown as SeRankingClient;

    const report =
      await SeRankingProjectService.validateAccessAndQuota(clientWithLimits);
    expect(report.projectCapacity).toMatchObject({
      status: "ok",
      limit: 10,
      used: 1,
      remaining: 9,
      source: "provider_reported",
    });
    expect(report.trackedKeywordCapacity).toMatchObject({
      status: "ok",
      limit: 500,
      used: 120,
      remaining: 380,
      source: "provider_reported",
    });

    const unauthClient = {
      request: vi.fn(async () => {
        throw new SeRankingAuthError("Invalid API token", 401);
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.validateAccessAndQuota(unauthClient),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const forbiddenClient = {
      request: vi.fn(async () => {
        throw new SeRankingAuthError("No Project API permission", 403);
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.validateAccessAndQuota(forbiddenClient),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const unpaidClient = {
      request: vi.fn(async () => {
        throw new SeRankingCreditExhaustedError(
          "Project subscription paused",
          402,
        );
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.validateAccessAndQuota(unpaidClient),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    const rateLimitedClient = {
      request: vi.fn(async () => {
        throw new SeRankingRateLimitError("Too many requests");
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.validateAccessAndQuota(rateLimitedClient),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("explicitly sends check_freq='manual', auto_reports=0, disable_audit=1 on createSite", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = {
      request: vi.fn(async (_path: string, opts?: { body?: unknown }) => {
        capturedBody = opts?.body as Record<string, unknown>;
        return {
          id: 9001,
          url: "https://example.com",
          title: "Example",
          depth: 100,
          check_freq: "manual",
        };
      }),
    } as unknown as SeRankingClient;

    await SeRankingProjectService.createSite(client, {
      url: "https://example.com",
      title: "Example",
    });

    expect(capturedBody).toEqual({
      url: "https://example.com",
      title: "Example",
      depth: 100,
      subdomain_match: 0,
      exact_url: 0,
      check_freq: "manual",
      auto_reports: 0,
      disable_audit: 1,
    });
  });

  it("classifies keyword capacity, engine allocation, and recheck restriction errors distinctly", async () => {
    const kwBlockedClient = {
      request: vi.fn(async () => {
        throw new SeRankingCreditExhaustedError(
          "Keyword limit exceeded for plan",
          402,
        );
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.addKeywords(kwBlockedClient, {
        siteId: 1,
        keywords: [{ keyword: "seo" }],
      }),
    ).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      details: { dimension: "tracked_keyword_capacity" },
    });

    const engineBlockedClient = {
      request: vi.fn(async () => {
        throw new SeRankingCreditExhaustedError(
          "Search engine limit reached",
          402,
        );
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.addSiteSearchEngine(engineBlockedClient, {
        siteId: 1,
        searchEngineId: 200,
      }),
    ).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      details: { dimension: "device_location_allocations" },
    });

    const recheckRestrictedClient = {
      request: vi.fn(async () => {
        throw new SeRankingCreditExhaustedError("Recheck cooldown active", 402);
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.recheckPositions(recheckRestrictedClient, {
        siteId: 1,
        keywordIds: ["100"],
      }),
    ).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      details: { dimension: "recheck_restrictions" },
    });
  });

  it("verifySiteAccessible distinguishes accessible, confirmed inaccessible (404/403), and transient uncertainty (429/5xx)", async () => {
    const accessibleViaProbe = {
      request: vi.fn(async () => [{ site_engine_id: 300 }]),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.verifySiteAccessible(accessibleViaProbe, 77, []),
    ).resolves.toBe(true);

    const missingRemote = {
      request: vi.fn(async () => {
        throw new SeRankingNotFoundError("Site not found", 404);
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.verifySiteAccessible(missingRemote, 77, []),
    ).resolves.toBe(false);

    const transientClient = {
      request: vi.fn(async () => {
        throw new SeRankingUpstreamError("503 backend down", 503);
      }),
    } as unknown as SeRankingClient;
    await expect(
      SeRankingProjectService.verifySiteAccessible(transientClient, 77, []),
    ).rejects.toBeInstanceOf(AppError);
  });
});
