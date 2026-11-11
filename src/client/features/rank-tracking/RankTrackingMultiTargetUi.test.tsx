import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/serverFunctions/rank-tracking-targets", () => ({
  addRankTrackingTarget: vi.fn(),
  toggleRankTrackingTarget: vi.fn(),
  retrySeRankingProjectSyncFn: vi.fn(),
}));

import { RankTrackingDetailHeader } from "./RankTrackingDetailHeader";
import { RankTrackingTargetsModal } from "./RankTrackingTargetsModal";
import type {
  RankTrackingConfig,
  RankTrackingTarget,
} from "@/types/schemas/rank-tracking";

const SAMPLE_CONFIG: RankTrackingConfig = {
  id: "cfg-1",
  projectId: "proj-1",
  domain: "example.com",
  locationCode: 2818,
  locationName: "Egypt",
  languageCode: "ar",
  devices: "both",
  serpDepth: 100,
  scheduleInterval: "weekly",
  isActive: true,
  lastCheckedAt: "2026-11-11T10:00:00Z",
  nextCheckAt: null,
  lastSkipReason: null,
  createdAt: "2026-11-01T10:00:00Z",
};

const SAMPLE_TARGETS: RankTrackingTarget[] = [
  {
    id: "t-eg",
    organizationId: "org-1",
    localProjectId: "proj-1",
    trackingConfigId: "cfg-1",
    searchEngine: "google",
    countryCode: "eg",
    cityName: null,
    languageCode: "ar",
    device: "desktop",
    enabled: true,
  },
  {
    id: "t-sa",
    organizationId: "org-1",
    localProjectId: "proj-1",
    trackingConfigId: "cfg-1",
    searchEngine: "google",
    countryCode: "sa",
    cityName: "Riyadh",
    languageCode: "ar",
    device: "mobile",
    enabled: false,
  },
];

describe("Rank Tracking Multi-Target UI", () => {
  it("renders interactive target filter pills and Targets button in RankTrackingDetailHeader", () => {
    const markup = renderToStaticMarkup(
      <RankTrackingDetailHeader
        config={SAMPLE_CONFIG}
        run={{ lastCheckedAt: "2026-11-11T10:00:00Z" }}
        targets={SAMPLE_TARGETS}
        selectedTargetId="t-eg"
        onSelectedTargetChange={vi.fn()}
        onManageTargets={vi.fn()}
        costEstimate={{ keywordCount: 10, costUsd: 0 }}
        hasBothDevices={true}
        activeDevice="desktop"
        onActiveDeviceChange={vi.fn()}
        comparePeriod="7d"
        onComparePeriodChange={vi.fn()}
        onEdit={vi.fn()}
        onToggleAddKeywords={vi.fn()}
      />,
    );

    expect(markup).toContain("All targets");
    expect(markup).toContain("EG · Countrywide (ar) · desktop");
    expect(markup).not.toContain("SA · Riyadh (ar) · mobile");
    expect(markup).toContain("Targets");
  });

  it("renders multi-country, city, language, independent desktop/mobile form and non-destructive disable/re-enable toggles", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RankTrackingTargetsModal
          projectId="proj-1"
          configId="cfg-1"
          targets={SAMPLE_TARGETS}
          defaultCountryCode="eg"
          defaultLanguageCode="ar"
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Multi-Location &amp; Device Targets");
    expect(markup).toContain("Country");
    expect(markup).toContain("City / Region");
    expect(markup).toContain("Language");
    expect(markup).toContain("Desktop");
    expect(markup).toContain("Mobile");
    expect(markup).toContain("Sync SE Ranking");
    expect(markup).toContain("Disable");
    expect(markup).toContain("Re-enable");
    expect(markup).toContain("never issues remote DELETE");
  });
});
