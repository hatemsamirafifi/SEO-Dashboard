import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// §1.5 gating: the connector must be inert unless the operator explicitly
// enables it AND supplies Partners app credentials.
const { getOptionalEnvValue } = vi.hoisted(() => ({
  getOptionalEnvValue: vi.fn<(name: string) => Promise<string | undefined>>(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (...args: Parameters<typeof getOptionalEnvValue>) =>
    getOptionalEnvValue(...args),
}));

import {
  isSallaConnectorConfigured,
  resolveSallaConnectorConfig,
  SALLA_API_BASE_URL,
  SALLA_AUTHORIZE_URL,
  SALLA_CALLBACK_PATH,
  SALLA_OAUTH_SCOPES,
  SALLA_TOKEN_URL,
  SALLA_USER_INFO_URL,
} from "./sallaConfig";

async function setEnv(values: Record<string, string | undefined>) {
  getOptionalEnvValue.mockImplementation(async (name: string) => values[name]);
}

beforeEach(() => {
  getOptionalEnvValue.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Salla connector configuration gate", () => {
  it("contracts match the verified docs endpoints", () => {
    expect(SALLA_AUTHORIZE_URL).toBe("https://accounts.salla.sa/oauth2/auth");
    expect(SALLA_TOKEN_URL).toBe("https://accounts.salla.sa/oauth2/token");
    expect(SALLA_USER_INFO_URL).toBe(
      "https://accounts.salla.sa/oauth2/user/info",
    );
    expect(SALLA_API_BASE_URL).toBe("https://api.salla.dev/admin/v2");
    expect(SALLA_CALLBACK_PATH).toBe("/api/salla/oauth/callback");
  });

  it("is disabled by default: no env at all resolves to null", async () => {
    await setEnv({});
    expect(await resolveSallaConnectorConfig()).toBeNull();
    expect(await isSallaConnectorConfigured()).toBe(false);
  });

  it("demands an explicit opt-in flag even with credentials present", async () => {
    await setEnv({
      SALLA_CLIENT_ID: "cid",
      SALLA_CLIENT_SECRET: "c-sekret",
    });
    expect(await resolveSallaConnectorConfig()).toBeNull();
    await setEnv({
      SALLA_CLIENT_ID: "cid",
      SALLA_CLIENT_SECRET: "c-sekret",
      SALLA_CONNECTOR_ENABLED: "false",
    });
    expect(await resolveSallaConnectorConfig()).toBeNull();
  });

  it("enables only with the flag on and both credentials present", async () => {
    await setEnv({
      SALLA_CLIENT_ID: "cid",
      SALLA_CLIENT_SECRET: "c-sekret",
      SALLA_CONNECTOR_ENABLED: "true",
    });
    expect(await resolveSallaConnectorConfig()).toEqual({
      clientId: "cid",
      clientSecret: "c-sekret",
    });
    expect(await isSallaConnectorConfigured()).toBe(true);
  });

  it("refuses a one-legged client: id without secret or the reverse", async () => {
    await setEnv({
      SALLA_CLIENT_ID: "cid",
      SALLA_CONNECTOR_ENABLED: "true",
    });
    expect(await resolveSallaConnectorConfig()).toBeNull();
    await setEnv({
      SALLA_CLIENT_SECRET: "c-sekret",
      SALLA_CONNECTOR_ENABLED: "true",
    });
    expect(await resolveSallaConnectorConfig()).toBeNull();
  });

  it("requests least-privilege read-only scopes plus offline_access", () => {
    expect(SALLA_OAUTH_SCOPES).not.toContain("products.read_write");
    expect(SALLA_OAUTH_SCOPES).not.toContain("customers.read");
    expect(SALLA_OAUTH_SCOPES).toContain("products.read");
    expect(SALLA_OAUTH_SCOPES).toContain("categories.read");
    expect(SALLA_OAUTH_SCOPES).toContain("offline_access");
  });
});
