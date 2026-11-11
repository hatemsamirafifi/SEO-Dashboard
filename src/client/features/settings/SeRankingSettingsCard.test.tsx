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
});
