import process from "node:process";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  NonRetryableError: class NonRetryableError extends Error {},
}));

import { renderToStaticMarkup } from "react-dom/server";
import {
  safeProviderReason,
  parseDataforseoStatusCode,
} from "@/server/workflows/rankCheckPaths";
import {
  toDeviceResult,
} from "@/server/features/rank-tracking/services/rankTrackingResults";

type SnapshotRow = Parameters<typeof toDeviceResult>[0];
import { buildRankCompletionPatch } from "@/client/features/rank-tracking/rankTraceCompletion";
import {
  DeviceRankCell,
  DeviceUrlCell,
} from "@/client/features/rank-tracking/RankTrackingTableParts";
import { loadLocalEnv } from "../../../../../scripts/cli-utils";

interface DataforseoTaskResult {
  status_code?: number;
  status_message?: string;
}

interface DataforseoLiveResponse {
  status_code?: number;
  status_message?: string;
  tasks?: DataforseoTaskResult[];
}

type ProviderErrorFixture = Error & {
  statusCode?: number;
  status?: number;
};

loadLocalEnv();
process.env.DATAFORSEO_ENABLED = "true";

describe("Live and Paused-Account Rank Check Verification", () => {
  const apiKey = process.env.DATAFORSEO_API_KEY;

  it(
    "1. Live DataForSEO API call returns upstream error and truthful diagnostics",
    async () => {
      expect(apiKey).toBeDefined();

      const start = Date.now();
      const res = await fetch(
        "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            {
              keyword: "seo agency dubai",
              location_code: 2840,
              language_code: "en",
              depth: 20,
            },
          ]),
        },
      );
      const data: DataforseoLiveResponse = await res.json();
      const elapsed = Date.now() - start;
      console.log(`Live DataForSEO call finished in ${elapsed}ms with HTTP ${res.status}`);

      const firstTask = data.tasks?.[0];
      const taskStatusCode = firstTask?.status_code ?? data.status_code;
      const taskStatusMessage = firstTask?.status_message ?? data.status_message;

      // Real live DataForSEO account is currently paused / out-of-funds
      expect(res.status).toBe(402);
      expect(taskStatusCode).toBe(40200);
      expect(taskStatusMessage).toBe("Payment Required.");

      const caughtError: ProviderErrorFixture = new Error(
        `DataForSEO task error (${taskStatusCode}): ${taskStatusMessage}`,
      );
      caughtError.statusCode = taskStatusCode;
      caughtError.status = res.status;

      const reason = safeProviderReason(caughtError);
      const parsedCode = parseDataforseoStatusCode(caughtError);
      expect(parsedCode).toBe(40200);
      expect(reason).toContain("DataForSEO task error (40200): Payment Required.");

      // Verify that budget-related provider error correctly reports budgetGuard = BLOCKED
      const patch = buildRankCompletionPatch({
        run: {
          id: "live_run_test_budget",
          status: "failed",
          keywordsChecked: 0,
          keywordsTotal: 1,
          errorMessage: `Completed 0 of 1 keyword(s). Error: ${reason}`,
          startedAt: new Date(Date.now() - 5000).toISOString(),
        },
        rows: [],
        targetIds: ["kw_1"],
      });

      expect(patch.status).toBe("failed");
      expect(patch.errorClass).toBe("CREDITS_UNAVAILABLE");
      expect(patch.budget).toBe("BLOCKED");
      expect(patch.providers?.[0]?.budgetGuard).toBe("BLOCKED");
    },
    30000,
  );

  it("2. Paused account (40201) correctly reports budgetGuard PASS and truthful semantics end-to-end", () => {
    // Exact DataForSEO 40201 upstream task error payload
    const pausedError: ProviderErrorFixture = new Error(
      "DataForSEO task error (40201): We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access to our services as a precaution.",
    );
    pausedError.statusCode = 40201;
    pausedError.status = 200;

    const reason = safeProviderReason(pausedError);
    const parsedCode = parseDataforseoStatusCode(pausedError);
    expect(parsedCode).toBe(40201);
    expect(reason).toContain("DataForSEO task error (40201)");
    expect(reason).toContain("temporarily paused access");

    // Map into snapshot row with previous position = 8
    const prevPosition = 8;
    const snapshotRow: SnapshotRow = {
      id: 1,
      runId: "live_run_paused_1",
      trackingKeywordId: "kw_live_1",
      keyword: "seo agency dubai",
      device: "desktop",
      position: null,
      previousPosition: prevPosition,
      rankingStatus: "CHECK_FAILED",
      url: null,
      serpFeatures: null,
      provider: "dataforseo",
      providerStatus: reason,
      providerStatusCode: parsedCode,
      errorMessage: reason,
      checkedAt: new Date().toISOString(),
    };

    const deviceResult = toDeviceResult(
      snapshotRow,
      prevPosition,
      /* latestValidPosition */ prevPosition,
    );

    // Safeguard 1: CHECK_FAILED is an attempt outcome, not an unranked observation
    expect(deviceResult.status).toBe("failed");
    expect(deviceResult.rankingStatus).toBe("CHECK_FAILED");
    expect(deviceResult.position).toBeNull();
    expect(deviceResult.previousPosition).toBe(8);
    expect(deviceResult.latestValidPosition).toBe(8);
    expect(deviceResult.errorCode).toBe("DATAFORSEO_ACCOUNT_PAUSED");

    // Global Trace completion patch:
    // Expected:
    // provider = DataForSEO
    // HTTP transport = 200
    // provider task status = 40201
    // errorClass = DATAFORSEO_ACCOUNT_PAUSED
    // budgetGuard = PASS
    const patch = buildRankCompletionPatch({
      run: {
        id: "live_run_paused_1",
        status: "failed",
        keywordsChecked: 0,
        keywordsTotal: 1,
        errorMessage: `Completed 0 of 1 keyword(s). Error: ${reason}`,
        startedAt: new Date(Date.now() - 5000).toISOString(),
      },
      rows: [
        {
          trackingKeywordId: "kw_live_1",
          keyword: "seo agency dubai",
          desktop: {
            position: null,
            previousPosition: prevPosition,
            checkedAt: snapshotRow.checkedAt,
            status: deviceResult.status,
            rankingStatus: deviceResult.rankingStatus,
            errorMessage: reason,
            providerStatusCode: parsedCode,
          },
        },
      ],
      targetIds: ["kw_live_1"],
    });

    expect(patch.status).toBe("failed");
    expect(patch.errorClass).toBe("DATAFORSEO_ACCOUNT_PAUSED");
    expect(patch.budget).toBe("PASS"); // NOT BLOCKED
    expect(patch.httpStatus).toBe(200); // Truthful HTTP transport
    expect(patch.providers?.[0]?.provider).toBe("DataForSEO");
    expect(patch.providers?.[0]?.taskStatus).toBe(40201);
    expect(patch.providers?.[0]?.budgetGuard).toBe("PASS"); // Budget guard did NOT block
    expect(patch.children?.[0]?.rankingStatus).toBe("CHECK_FAILED");
    expect(patch.children?.[0]?.status).toBe("failed");

    // UI Table rendering
    const rankHtml = renderToStaticMarkup(
      React.createElement(DeviceRankCell, {
        result: deviceResult,
        serpDepth: 20,
      }),
    );
    const urlHtml = renderToStaticMarkup(
      React.createElement(DeviceUrlCell, {
        result: deviceResult,
        domain: "powersiment.ae",
        serpDepth: 20,
      }),
    );

    // Keyword row renders "Ranking unavailable"
    expect(rankHtml).toContain("Ranking unavailable");
    expect(rankHtml).toContain("Last valid: #8");
    // Must NOT show false lost or no ranking found
    expect(rankHtml).not.toContain("lost");
    expect(rankHtml).not.toContain("No ranking found");

    // URL cell renders "—" with failure tooltip, not "No ranking URL"
    expect(urlHtml).toContain("—");
    expect(urlHtml).not.toContain("No ranking URL");
  });
});
