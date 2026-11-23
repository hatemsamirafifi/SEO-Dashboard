import { defineConfig } from "@playwright/test";

const existingBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim();
const fixturePort = 3197;
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;

export default defineConfig({
  testDir: "./e2e",
  testIgnore:
    process.env.PLAYWRIGHT_SERANKING_MOCK === "1"
      ? []
      : ["**/seranking-selective-sync.spec.ts"],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: existingBaseUrl || fixtureUrl,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  // An explicit base URL runs against an already-started application.
  webServer: existingBaseUrl
    ? undefined
    : {
        command: `pnpm exec vite dev --mode e2e --host 127.0.0.1 --port ${fixturePort} --strictPort`,
        url: fixtureUrl,
        env: {
          NODE_OPTIONS: "",
          AUTH_MODE: "local_noauth",
          VITE_E2E_DOMAIN_FIXTURES: "1",
          VITE_E2E_KEYWORD_FIXTURES: "1",
          VITE_E2E_AUDIT_FIXTURES: "1",
          PORT: String(fixturePort),
        },
        reuseExistingServer: false,
        timeout: 300_000,
      },
});
