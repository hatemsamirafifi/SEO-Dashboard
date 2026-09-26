import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

const credentialsSchema = z.object({ apiKey: z.string().min(1) });

async function encryptionKey(provider: string): Promise<string | null> {
  const base =
    (await getOptionalEnvValue("AI_CREDENTIALS_ENCRYPTION_KEY")) ??
    (await getOptionalEnvValue("BETTER_AUTH_SECRET"));
  return base ? `${base}:serp-${provider}-credentials-v1` : null;
}

export async function encryptSerpApiKey(
  provider: string,
  apiKey: string,
): Promise<string | null> {
  const key = await encryptionKey(provider);
  return key
    ? symmetricEncrypt({ key, data: JSON.stringify({ apiKey }) })
    : null;
}

export async function decryptSerpApiKey(
  provider: string,
  ciphertext: string | null | undefined,
): Promise<string | null> {
  if (!ciphertext) return null;
  const key = await encryptionKey(provider);
  if (!key) return null;
  try {
    const plaintext = await symmetricDecrypt({ key, data: ciphertext });
    const parsed = credentialsSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data.apiKey : null;
  } catch {
    return null;
  }
}

export function maskSerpApiKey(
  apiKey: string | null | undefined,
): string | null {
  const value = apiKey?.trim();
  if (!value) return null;
  return value.length <= 4 ? "••••••••" : `••••••••••${value.slice(-4)}`;
}
