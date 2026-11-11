import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SeRankingSettingsCard } from "./SeRankingSettingsCard";
import type { SeRankingSettingsView } from "@/serverFunctions/serankingSettings";

vi.mock("@/serverFunctions/serankingSettings", () => ({
  getSeRankingSettings: vi.fn(),
  saveSeRankingSettingsFn: vi.fn(),
  testSeRankingConnectionFn: vi.fn(),
  removeSeRankingSettingsFn: vi.fn(),
}));

vi.mock("@/serverFunctions/rank-tracking-targets", () => ({
  getSeRankingSyncStatusFn: vi.fn(),
  migrateSeRankingAccountFn: vi.fn(),
  retrySeRankingProjectSyncFn: vi.fn(),
}));

describe("SeRankingSettingsCard", () => {
  function renderWithQueryClient(
    ui: React.ReactElement,
    initialData?: SeRankingSettingsView,
  ) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    if (initialData) {
      queryClient.setQueryData(["seRankingSettings", null], initialData);
    }

    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    );
  }

  it("renders loading state when data is not yet resolved", () => {
    const markup = renderWithQueryClient(<SeRankingSettingsCard />);
    expect(markup).toContain("loading loading-spinner");
  });

  it("renders configured settings view with credentials, toggles, and rate limit disclaimers", () => {
    const mockView: SeRankingSettingsView = {
      provider: "seranking",
      configured: true,
      enabled: true,
      circuitBreakerEnabled: true,
      maxRetries: 2,
      priority: 1,
      source: "organization",
      apiKeyMasked: "••••••••••••3xyz",
      scope: "organization",
      override: null,
      circuit: {
        state: "closed",
        openedAt: null,
        expiresAt: null,
        reason: null,
        retryAfterMs: null,
      },
    };

    const markup = renderWithQueryClient(<SeRankingSettingsCard />, mockView);

    // Header & identity
    expect(markup).toContain("SE Ranking");
    expect(markup).toContain("Organization");
    expect(markup).toContain("Configured");
    expect(markup).toContain("Primary Provider");

    // Masked credential display
    expect(markup).toContain("••••••••••••3xyz");

    // Action buttons & toggles
    expect(markup).toContain("Test connection");
    expect(markup).toContain("Save");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("Circuit breaker");
    expect(markup).toContain("Circuit health");
    expect(markup).toContain("Healthy");
  });

  it("renders project-level override badge and clear button when override exists", () => {
    const mockView: SeRankingSettingsView = {
      provider: "seranking",
      configured: true,
      enabled: true,
      circuitBreakerEnabled: true,
      maxRetries: 2,
      priority: 1,
      source: "project",
      apiKeyMasked: "••••••••••••9abc",
      scope: "project",
      override: {
        configured: true,
        enabled: true,
        circuitBreakerEnabled: true,
        maxRetries: 2,
        priority: 1,
        apiKeyMasked: "••••••••••••9abc",
      },
      circuit: {
        state: "closed",
        openedAt: null,
        expiresAt: null,
        reason: null,
        retryAfterMs: null,
      },
    };

    const queryClient = new QueryClient();
    queryClient.setQueryData(["seRankingSettings", "proj-1"], mockView);

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SeRankingSettingsCard projectId="proj-1" />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Clear override");
    expect(markup).toContain("Project");
  });

  it("correctly displays Connected and 100000 available credits after a successful response", () => {
    const mockView: SeRankingSettingsView = {
      provider: "seranking",
      configured: true,
      enabled: true,
      circuitBreakerEnabled: true,
      maxRetries: 2,
      priority: 1,
      source: "organization",
      apiKeyMasked: "••••••••••••1234",
      scope: "organization",
      override: null,
      circuit: {
        state: "closed",
        openedAt: null,
        expiresAt: null,
        reason: null,
        retryAfterMs: null,
      },
    };

    const queryClient = new QueryClient();
    queryClient.setQueryData(["seRankingSettings", null], mockView);

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SeRankingSettingsCard
          initialTestResult={{
            ok: true,
            status: 200,
            reason: "CONNECTED",
            balance: 100000,
            unitsLimit: 100000,
            subscriptionStatus: "active",
          }}
        />
      </QueryClientProvider>,
    );

    // Verify Connected status badge
    expect(markup).toContain("Connected");
    // Verify 100,000 units left in overview grid
    expect(markup).toContain("100,000");
    // Verify detailed connection success notification banner
    expect(markup).toContain("SE Ranking API connected successfully");
    expect(markup).toContain(
      'Subscription: <span class="font-semibold">active</span>',
    );
    expect(markup).toContain("Limit: 100,000 units");
    expect(markup).toContain("Available: 100,000 units");
  });

  it("displays Project API accessibility separately when Data API credits are 0 and renders sync/migration controls", () => {
    const mockView: SeRankingSettingsView = {
      provider: "seranking",
      configured: true,
      enabled: true,
      circuitBreakerEnabled: true,
      maxRetries: 2,
      priority: 1,
      source: "organization",
      apiKeyMasked: "••••••••••••1234",
      scope: "organization",
      override: null,
      circuit: {
        state: "closed",
        openedAt: null,
        expiresAt: null,
        reason: null,
        retryAfterMs: null,
      },
    };

    const queryClient = new QueryClient();
    queryClient.setQueryData(["seRankingSettings", null], mockView);
    queryClient.setQueryData(["seRankingSyncStatus", null], {
      accounts: [
        {
          id: "acc-1",
          status: "migration_required",
          credentialVersion: 1,
          lastValidatedAt: "2026-11-11T10:00:00Z",
          updatedAt: "2026-11-11T10:00:00Z",
        },
      ],
      projects: [
        {
          projectBindingId: "pb-1",
          localProjectId: "proj-1",
          projectName: "Example Store",
          projectDomain: "example.com",
          providerAccountBindingId: "acc-1",
          remoteSiteId: 4002,
          status: "failed",
          lastSuccessfulSync: null,
          errorMessage: "Temporary rate limit",
          updatedAt: "2026-11-11T10:00:00Z",
          engineBindingsCount: 2,
          keywordMappingsCount: 18,
          activeTargetsCount: 2,
          isLatestForProject: true,
        },
      ],
      needsMigrationCount: 0,
      failedSyncCount: 1,
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SeRankingSettingsCard
          initialTestResult={{
            ok: false,
            status: 200,
            reason: "CREDITS_UNAVAILABLE",
            balance: 0,
            unitsLimit: 1000,
            subscriptionStatus: "active",
            projectApi: {
              accessible: true,
              siteCount: 2,
              trackedKeywords: 40,
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Project API (Rank Tracking)");
    expect(markup).toContain("Accessible");
    expect(markup).toContain("2 site(s)");
    expect(markup).toContain("Reconcile &amp; Migrate Projects");
    expect(markup).toContain("Example Store");
    expect(markup).toContain("Retry Sync");
  });
});
