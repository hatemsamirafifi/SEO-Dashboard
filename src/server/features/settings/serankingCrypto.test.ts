import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) =>
    name === "AI_CREDENTIALS_ENCRYPTION_KEY" ? "test-encryption-key-for-seranking" : null,
  ),
}));

import {
  decryptSeRankingApiKey,
  encryptSeRankingApiKey,
  maskSeRankingApiKey,
} from "./serankingCrypto";

describe("SE Ranking credential security", () => {
  beforeEach(() => vi.clearAllMocks());

  it("encrypts and decrypts API key at rest using AES-GCM", async () => {
    const secret = "seranking_secret_api_key_12345";
    const ciphertext = await encryptSeRankingApiKey(secret);
    expect(ciphertext).toBeTypeOf("string");
    expect(ciphertext).not.toContain(secret);
    const decrypted = await decryptSeRankingApiKey(ciphertext);
    expect(decrypted).toBe(secret);
  });

  it("returns null when decrypting corrupted ciphertext", async () => {
    const invalidCiphertext = "not-a-valid-encrypted-string";
    const decrypted = await decryptSeRankingApiKey(invalidCiphertext);
    expect(decrypted).toBeNull();
  });

  it("masks API key for safe browser display without exposing raw token", () => {
    expect(maskSeRankingApiKey("abcdef1234567890")).toBe("••••••••••7890");
    expect(maskSeRankingApiKey("abcd")).toBe("••••••••");
  });
});
