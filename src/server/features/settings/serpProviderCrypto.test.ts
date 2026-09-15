import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) =>
    name === "AI_CREDENTIALS_ENCRYPTION_KEY" ? "test-encryption-key" : null,
  ),
}));

import {
  decryptSerpApiKey,
  encryptSerpApiKey,
  maskSerpApiKey,
} from "./serpProviderCrypto";

describe("SERP provider credential security", () => {
  beforeEach(() => vi.clearAllMocks());

  it("encrypts API keys at rest with provider domain separation", async () => {
    const secret = "real-provider-secret";
    const ciphertext = await encryptSerpApiKey("serper", secret);
    expect(ciphertext).toBeTypeOf("string");
    expect(ciphertext).not.toContain(secret);
    expect(await decryptSerpApiKey("serper", ciphertext)).toBe(secret);
    expect(await decryptSerpApiKey("zenserp", ciphertext)).toBeNull();
  });

  it("returns only a masked suffix for browser views", () => {
    expect(maskSerpApiKey("1234567890abcdef")).toBe("••••••••••cdef");
    expect(maskSerpApiKey("abc")).toBe("••••••••");
  });
});
