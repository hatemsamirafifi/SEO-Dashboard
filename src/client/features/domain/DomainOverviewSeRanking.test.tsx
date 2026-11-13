import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatCard } from "./components/StatCard";
import { formatMetric, formatNumber } from "./utils";
import { PROVIDER_DISPLAY_LABELS } from "@/client/features/sam/samTraceFormat";

describe("Domain Overview & SE Ranking Frontend Integration", () => {
  it("formats SE Ranking metrics correctly in StatCards", () => {
    // When SE Ranking returns organic traffic and keywords
    const trafficValue = formatMetric(25400, true);
    const keywordsValue = formatMetric(850, true);

    const trafficCard = renderToStaticMarkup(
      <StatCard label="Estimated Organic Traffic" value={trafficValue} />,
    );
    const keywordsCard = renderToStaticMarkup(
      <StatCard label="Organic Keywords" value={keywordsValue} />,
    );

    expect(trafficCard).toContain("Estimated Organic Traffic");
    expect(trafficCard).toContain("25,400");
    expect(keywordsCard).toContain("Organic Keywords");
    expect(keywordsCard).toContain("850");
  });

  it("handles null and empty SE Ranking metrics gracefully without crashes", () => {
    const nullMetric = formatNumber(null);
    expect(nullMetric).toBe("-");

    const noDataMetric = formatMetric(null, false);
    expect(noDataMetric).toBe("Not enough data");

    const card = renderToStaticMarkup(
      <StatCard label="Estimated Organic Traffic" value={noDataMetric} />,
    );
    expect(card).toContain("Not enough data");
  });

  it("registers SE Ranking in SAM provider display labels", () => {
    expect(PROVIDER_DISPLAY_LABELS.seranking).toBe("SE Ranking");
    expect(PROVIDER_DISPLAY_LABELS.dataforseo).toBe("DataForSEO");
    expect(PROVIDER_DISPLAY_LABELS.google_ads).toBe("Google Ads");
  });
});
