import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3101",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite dev --host 127.0.0.1 --port 3101 --strictPort",
    url: "http://127.0.0.1:3101",
    env: {
      NODE_OPTIONS: "",
      AUTH_MODE: "local_noauth",
      VITE_E2E_DOMAIN_FIXTURES: "1",
      VITE_E2E_KEYWORD_FIXTURES: "1",
      VITE_E2E_AUDIT_FIXTURES: "1",
      PORT: "3101",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
