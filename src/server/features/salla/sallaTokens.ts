import { symmetricEncrypt, symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { SALLA_OAUTH_SCOPES } from "./sallaConfig";

// Sealed-at-rest storage for Salla OAuth tokens (§1.5).
//
// - Primitive mirrors the audited AI-credential storage: better-auth's
//   symmetricEncrypt (AES-GCM, random IV, versioned envelope).
// - Key: SALLA_TOKEN_ENCRYPTION_KEY ONLY. Deliberately NOT
//   BETTER_AUTH_SECRET (upstream Shopify review teaching) and deliberately no
//   fallback, so a deployment missing the dedicated secret can never silently
//   write sealed tokens under a shared key. Domain-separated
//   (`:salla-oauth-v1`) so Salla ciphertext cannot be cross-decrypted by any
//   other credential scope.
// - Unreadable ciphertext (wrong/rotated key) decrypts to null: the service
//   treats a grant as "must re-authorize" instead of crashing or leaking.

const KEY_DOMAIN = ":salla-oauth-v1";

// Docs return `expires` (seconds); tolerate `expires_in` as well.
export const sallaTokenGrantSchema = z.object({
  access_token: z.string().min(1),
  expires: z.number().int().positive().optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type SallaTokenGrant = z.infer<typeof sallaTokenGrantSchema>;

export type SallaTokenEnvelope = {
  accessToken: string;
  refreshToken: string | null;
  // Epoch milliseconds.
  expiresAt: number;
  scope: string;
};

const tokenEnvelopeSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.number().int().positive(),
  scope: z.string().min(1),
});

export async function resolveSallaTokenKey(): Promise<string | null> {
  const key = await getOptionalEnvValue("SALLA_TOKEN_ENCRYPTION_KEY");
  if (!key) return null;
  return `${key}${KEY_DOMAIN}`;
}

/** null when the dedicated secret is unset — callers must not store plaintext. */
export async function encryptSallaTokenEnvelope(
  envelope: SallaTokenEnvelope,
): Promise<string | null> {
  const key = await resolveSallaTokenKey();
  if (!key) return null;
  return symmetricEncrypt({ key, data: JSON.stringify(envelope) });
}

/**
 * Returns null when storage is unkeyed, the ciphertext is unreadable, or the
 * plaintext is not the expected shape — callers treat a grant as
 * "must re-authorize" instead of crashing or leaking.
 */
export async function decryptSallaTokenEnvelope(
  ciphertext: string | null | undefined,
): Promise<SallaTokenEnvelope | null> {
  if (!ciphertext) return null;
  const key = await resolveSallaTokenKey();
  if (!key) return null;
  try {
    const parsed: unknown = JSON.parse(
      await symmetricDecrypt({ key, data: ciphertext }),
    );
    const result = tokenEnvelopeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    // Wrong key / corrupted envelope: fail safe, never throw to callers.
    return null;
  }
}

export function tokenEnvelopeFromGrant(
  tokens: SallaTokenGrant,
): SallaTokenEnvelope {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt:
      Date.now() + (tokens.expires ?? tokens.expires_in ?? 1209_599) * 1_000,
    scope: tokens.scope ?? SALLA_OAUTH_SCOPES.join(","),
  };
}
