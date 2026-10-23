import { afterEach, describe, expect, it, vi } from "vitest";

// Sealed-at-rest Salla tokens: AES-GCM envelope, dedicated secret (never
// BETTER_AUTH_SECRET, never scoped to other credential domains), unreadable
// ciphertext fails safe to null.
const { getOptionalEnvValue } = vi.hoisted(() => ({
  getOptionalEnvValue: vi.fn<(name: string) => Promise<string | undefined>>(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => getOptionalEnvValue(name),
}));

import {
  decryptSallaTokenEnvelope,
  encryptSallaTokenEnvelope,
  resolveSallaTokenKey,
  sallaTokenGrantSchema,
  tokenEnvelopeFromGrant,
} from "./sallaTokens";

afterEach(() => {
  vi.unstubAllEnvs();
  getOptionalEnvValue.mockReset?.();
});

describe("Salla token sealing", () => {
  it("returns no key without the dedicated secret", async () => {
    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "BETTER_AUTH_SECRET" ? "shared-secret" : undefined,
    );
    expect(await resolveSallaTokenKey()).toBeNull();
  });

  it("domain-separates the dedicated secret so ciphertext cannot be cross-decrypted", async () => {
    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "SALLA_TOKEN_ENCRYPTION_KEY" ? "salla-sekret" : undefined,
    );
    const key = await resolveSallaTokenKey();
    expect(key).toBe("salla-sekret:salla-oauth-v1");
  });

  it("round-trips an envelope through encryption", async () => {
    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "SALLA_TOKEN_ENCRYPTION_KEY" ? "key-a" : undefined,
    );
    const envelope = {
      accessToken: "ory_at_abc",
      refreshToken: "ory_rt_def",
      expiresAt: 1700000000000,
      scope: "products.read,categories.read,offline_access",
    };
    const ciphertext = await encryptSallaTokenEnvelope(envelope);
    expect(ciphertext).toBeTruthy();
    expect(ciphertext).not.toContain("ory_at_abc");
    expect(await decryptSallaTokenEnvelope(ciphertext)).toEqual(envelope);
  });

  it("refuses to encrypt when the dedicated secret is missing", async () => {
    getOptionalEnvValue.mockImplementation(async () => undefined);
    expect(
      await encryptSallaTokenEnvelope({
        accessToken: "x",
        refreshToken: null,
        expiresAt: 1,
        scope: "s",
      }),
    ).toBeNull();
  });

  it("fails safe to null on ciphertext sealed with another key", async () => {
    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "SALLA_TOKEN_ENCRYPTION_KEY" ? "key-a" : undefined,
    );
    const ciphertext = await encryptSallaTokenEnvelope({
      accessToken: "a",
      refreshToken: null,
      expiresAt: 1,
      scope: "s",
    });

    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "SALLA_TOKEN_ENCRYPTION_KEY" ? "key-b" : undefined,
    );
    expect(await decryptSallaTokenEnvelope(ciphertext)).toBeNull();
  });

  it("returns null for garbage ciphertext instead of throwing", async () => {
    getOptionalEnvValue.mockImplementation(async (name: string) =>
      name === "SALLA_TOKEN_ENCRYPTION_KEY" ? "key-a" : undefined,
    );
    expect(await decryptSallaTokenEnvelope("not-an-envelope")).toBeNull();
    expect(await decryptSallaTokenEnvelope(null)).toBeNull();
  });

  it("builds the envelope from a docs-shaped grant (`expires` in seconds)", () => {
    const envelope = tokenEnvelopeFromGrant({
      access_token: "ory_at_x",
      expires: 1209599,
      refresh_token: "ory_rt_y",
      scope: "settings.read products.read categories.read offline_access",
      token_type: "bearer",
    });
    expect(exchangeExpiresDelta(envelope.expiresAt)).toBe(1_209_599);
    expect(envelope.accessToken).toBe("ory_at_x");
    expect(envelope.refreshToken).toBe("ory_rt_y");
    expect(envelope.scope).toContain("products.read");
    expect(envelope.scope).toContain("offline_access");
  });

  it("treats a grant without a refresh token as unrefreshable", () => {
    const envelope = tokenEnvelopeFromGrant({ access_token: "a" });
    expect(envelope.refreshToken).toBeNull();
  });

  it("rejects token responses that carry no access token", () => {
    expect(sallaTokenGrantSchema.safeParse({}).success).toBe(false);
    expect(sallaTokenGrantSchema.safeParse({ access_token: "" }).success).toBe(
      false,
    );
    expect(
      sallaTokenGrantSchema.safeParse({ access_token: "ory_at_x" }).success,
    ).toBe(true);
  });
});

function exchangeExpiresDelta(expiresAt: number): number {
  return Math.round((expiresAt - Date.now()) / 1_000);
}
