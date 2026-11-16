import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn(), env: {} }));

vi.mock("@/serverFunctions/rank-tracking-targets", () => ({
  addRankTrackingTarget: vi.fn(),
  toggleRankTrackingTarget: vi.fn(),
  retrySeRankingProjectSyncFn: vi.fn(),
}));

import { RankTrackingDetailHeader } from "./RankTrackingDetailHeader";
import { RankTrackingTargetsModal } from "./RankTrackingTargetsModal";
import { CheckConfirmModal } from "./CheckConfirmModal";
import { ConfigAlerts } from "./ConfigAlerts";
import { resolveDeviceVisibility } from "./SeRankingProjectSyncBanner";
import { APPROVED_PILOT_CONFIG_ID } from "@/shared/rank-tracking";
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

  it("renders All devices, Desktop only, and Mobile only view toggle options with All devices active by default", () => {
    const markup = renderToStaticMarkup(
      <RankTrackingDetailHeader
        config={SAMPLE_CONFIG}
        run={{ lastCheckedAt: "2026-11-11T10:00:00Z" }}
        targets={SAMPLE_TARGETS}
        selectedTargetId={undefined}
        onSelectedTargetChange={vi.fn()}
        onManageTargets={vi.fn()}
        costEstimate={{
          keywordCount: 10,
          costUsd: 0,
          totalChecks: 20,
          pricingModel: "subscription_quota",
          provider: "seranking",
        }}
        hasBothDevices={true}
        activeDevice="all"
        onActiveDeviceChange={vi.fn()}
        comparePeriod="7d"
        onComparePeriodChange={vi.fn()}
        onEdit={vi.fn()}
        onToggleAddKeywords={vi.fn()}
      />,
    );

    // Segmented toggle options
    expect(markup).toContain("All devices");
    expect(markup).toContain("Desktop only");
    expect(markup).toContain("Mobile only");
    expect(markup).toContain("View:");
    // Display cost as subscription quota instead of DataForSEO $0.72
    expect(markup).toContain("~20 checks/run (subscription quota)");
    expect(markup).not.toContain("$0.72");
    expect(markup).not.toContain("$0.00/check");
  });

  it("resolveDeviceVisibility correctly resolves view scopes without mutating underlying tracking config", () => {
    // 1. Both devices configured, "all" selected -> both visible
    expect(resolveDeviceVisibility("both", "all")).toEqual({
      showDesktop: true,
      showMobile: true,
    });

    // 2. Both devices configured, "desktop" selected -> only desktop visible
    expect(resolveDeviceVisibility("both", "desktop")).toEqual({
      showDesktop: true,
      showMobile: false,
    });

    // 3. Both devices configured, "mobile" selected -> only mobile visible
    expect(resolveDeviceVisibility("both", "mobile")).toEqual({
      showDesktop: false,
      showMobile: true,
    });

    // 4. Target selected overrides device filter to that target's device
    const targetMobile = SAMPLE_TARGETS.find((t) => t.device === "mobile");
    expect(resolveDeviceVisibility("both", "all", targetMobile)).toEqual({
      showDesktop: false,
      showMobile: true,
    });

    const targetDesktop = SAMPLE_TARGETS.find((t) => t.device === "desktop");
    expect(resolveDeviceVisibility("both", "all", targetDesktop)).toEqual({
      showDesktop: true,
      showMobile: false,
    });

    // 5. Single device config
    expect(resolveDeviceVisibility("desktop", "desktop")).toEqual({
      showDesktop: true,
      showMobile: false,
    });
    expect(resolveDeviceVisibility("mobile", "mobile")).toEqual({
      showDesktop: false,
      showMobile: true,
    });

    // 6. Single device config with targets across both devices
    expect(resolveDeviceVisibility("desktop", "all", undefined, true)).toEqual({
      showDesktop: true,
      showMobile: true,
    });
  });

  it("CheckConfirmModal isolates execution scope and displays subscription quota for SE Ranking checks", () => {
    const markup = renderToStaticMarkup(
      <CheckConfirmModal
        keywordCount={10}
        devices="both"
        serpDepth={100}
        isPending={false}
        onRunNow={vi.fn()}
        onCancel={vi.fn()}
        isSeRanking={true}
        targetCount={2}
      />,
    );

    // Displays checks count and subscription quota
    expect(markup).toContain(
      "10 keywords across 2 targets = 20 checks (subscription quota)",
    );
    expect(markup).toContain("Subscription quota");
    // Does NOT display DataForSEO dollar amount
    expect(markup).not.toContain("$0.72");
    expect(markup).not.toContain("~$");
  });

  it("distinguishes full configuration capacity from active scheduled pilot scope in header and ConfigAlerts", () => {
    const pilotConfig: RankTrackingConfig = {
      ...SAMPLE_CONFIG,
      id: APPROVED_PILOT_CONFIG_ID,
      domain: "sports-ms.com",
    };

    // Header rendering for approved pilot configuration
    const headerMarkup = renderToStaticMarkup(
      <RankTrackingDetailHeader
        config={pilotConfig}
        run={{ lastCheckedAt: "2026-11-14T15:13:40Z" }}
        targets={SAMPLE_TARGETS}
        selectedTargetId={undefined}
        onSelectedTargetChange={vi.fn()}
        onManageTargets={vi.fn()}
        costEstimate={{
          keywordCount: 98,
          costUsd: null,
          totalChecks: 196,
          pricingModel: "subscription_quota",
          provider: "seranking",
        }}
        hasBothDevices={true}
        activeDevice="all"
        onActiveDeviceChange={vi.fn()}
        comparePeriod="7d"
        onComparePeriodChange={vi.fn()}
        onEdit={vi.fn()}
        onToggleAddKeywords={vi.fn()}
      />,
    );

    // Distinguishes full capacity from pilot scope
    expect(headerMarkup).toContain("~196 checks capacity (subscription quota)");
    expect(headerMarkup).toContain("pilot scope: 2 pairs (read-only)");

    // ConfigAlerts rendering for approved pilot configuration
    const alertMarkup = renderToStaticMarkup(
      <ConfigAlerts config={pilotConfig} latestRun={null} />,
    );

    expect(alertMarkup).toContain("Scheduled Read-Only Pilot Active");
    expect(alertMarkup).toContain("1 keyword · 2 observation pairs");
    expect(alertMarkup).toContain("read-only sync · 0 paid recheck POSTs");
    expect(alertMarkup).toContain("إنشاء ملاعب متعددة الأغراض");
    expect(alertMarkup).toContain("196 checks");
  });
});
