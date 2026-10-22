import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { verification } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  SALLA_AUTHORIZE_URL,
  SALLA_CALLBACK_PATH,
  SALLA_OAUTH_SCOPES,
  SALLA_OAUTH_STATE_IDENTIFIER,
  SALLA_TOKEN_URL,
  SALLA_USER_INFO_URL,
  type SallaConnectorConfig,
} from "./sallaConfig";
import { sallaTokenGrantSchema, type SallaTokenGrant } from "./sallaTokens";

// Salla OAuth authorization-code flow (Custom Mode), verified against the
// official docs at implementation time. Structure mirrors the audited
// selfHostedOAuth module: signed state, single-use nonce consumption, safe
// relative redirect, form-urlencoded code exchange, Zod-validated responses.

type SallaOwner = { userId: string; projectId: string };

const sallaOAuthStateSchema = z.object({
  userId: z.string().min(1),
  projectId: z.string().min(1),
  exp: z.number().int(),
  nonce: z.string().uuid(),
  callbackPath: z.string().min(1),
});

export type SallaOAuthState = z.infer<typeof sallaOAuthStateSchema>;

const sallaUserInfoSchema = z.object({
  status: z.number().optional(),
  success: z.boolean().optional(),
  data: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    merchant: z
      .object({
        id: z.union([z.string(), z.number()]),
        username: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    store: z
      .object({
        id: z.union([z.string(), z.number()]),
        domain: z.string().optional(),
        url: z.string().optional(),
        status: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
  }),
});

export type SallaStoreIdentity = {
  merchantId: string;
  merchantName: string | null;
  storeId: string;
  storeDomain: string | null;
  storeUrl: string | null;
  storeStatus: string | null;
};

// --- Signed state ------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getStateKey(clientSecret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`openseo:salla:${clientSecret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signState(payload: string, clientSecret: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getStateKey(clientSecret),
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function getSafeCallbackPath(callbackURL: string, publicOrigin: string) {
  try {
    const url = new URL(callbackURL, publicOrigin);
    if (url.origin !== publicOrigin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

async function createState(input: {
  owner: SallaOwner;
  clientSecret: string;
  callbackURL: string;
  publicOrigin: string;
}): Promise<string> {
  const nonce = crypto.randomUUID();
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        userId: input.owner.userId,
        projectId: input.owner.projectId,
        callbackPath: getSafeCallbackPath(
          input.callbackURL,
          input.publicOrigin,
        ),
        exp: Date.now() + 10 * 60 * 1_000,
        nonce,
      }),
    ),
  );
  // The nonce row makes state single-use: a captured state cannot be replayed
  // to register a second grant or swap the token envelope.
  const state = `${payload}.${await signState(payload, input.clientSecret)}`;
  await db.insert(verification).values({
    id: nonce,
    identifier: SALLA_OAUTH_STATE_IDENTIFIER,
    value: state,
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return state;
}

async function verifyState(
  state: string,
  clientSecret: string,
): Promise<SallaOAuthState> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new AppError("VALIDATION_ERROR", "Invalid Salla state");
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    await getStateKey(clientSecret),
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
  if (!ok) {
    throw new AppError("VALIDATION_ERROR", "Invalid Salla state");
  }
  const parsed = sallaOAuthStateSchema.parse(
    JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))),
  );
  if (parsed.exp < Date.now()) {
    throw new AppError("VALIDATION_ERROR", "Expired Salla state");
  }
  return parsed;
}

async function consumeState(state: { nonce: string }) {
  // Atomic single-use consumption: the delete-and-check pattern rejects a
  // concurrent replay of the same state.
  const consumed = await db
    .delete(verification)
    .where(
      and(
        eq(verification.id, state.nonce),
        eq(verification.identifier, SALLA_OAUTH_STATE_IDENTIFIER),
      ),
    )
    .returning({ id: verification.id });
  if (!consumed[0]) {
    throw new AppError("VALIDATION_ERROR", "Salla state was already used");
  }
}

// --- Endpoints ----------------------------------------------------------------

function projectIdFromCallbackPath(path: string): string | undefined {
  return /^\/p\/([^/?#]+)(?:\/|$)/.exec(path)?.[1];
}

export async function createSallaAuthorizationUrl(input: {
  owner: SallaOwner;
  clientSecret: string;
  clientId: string;
  callbackURL: string;
  publicOrigin: string;
}): Promise<string> {
  const state = await createState(input);
  const url = new URL(SALLA_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    `${input.publicOrigin}${SALLA_CALLBACK_PATH}`,
  );
  url.searchParams.set("scope", SALLA_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeSallaToken(
  params: Record<string, string>,
): Promise<SallaTokenGrant> {
  const response = await fetch(SALLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Salla rejected the token request.",
    );
  }
  const parsedJson: unknown = await response.json();
  const grant = sallaTokenGrantSchema.safeParse(parsedJson);
  if (!grant.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Salla returned an unexpected token response.",
    );
  }
  return grant.data;
}

function tokenParams(config: SallaConnectorConfig) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
  };
}

export async function exchangeSallaAuthorizationCode(input: {
  code: string;
  config: SallaConnectorConfig;
  publicOrigin: string;
}): Promise<SallaTokenGrant> {
  return exchangeSallaToken({
    ...tokenParams(input.config),
    grant_type: "authorization_code",
    code: input.code,
    // Must byte-match the redirect_uri sent to the authorize endpoint.
    redirect_uri: `${input.publicOrigin}${SALLA_CALLBACK_PATH}`,
  });
}

export async function refreshSallaToken(input: {
  refreshToken: string;
  config: SallaConnectorConfig;
}): Promise<SallaTokenGrant> {
  return exchangeSallaToken({
    ...tokenParams(input.config),
    grant_type: "refresh_token",
    // Salla refresh tokens are single-use; the server rotates the pair every
    // time — the response includes a new refresh token.
    refresh_token: input.refreshToken,
  });
}

export async function fetchSallaUserInfo(input: {
  accessToken: string;
}): Promise<SallaStoreIdentity> {
  const response = await fetch(SALLA_USER_INFO_URL, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Salla user info request failed.",
    );
  }
  const parsed = sallaUserInfoSchema.parse(await response.json());
  const merchant = parsed.data.merchant;
  const store = parsed.data.store;
  if (!merchant && !store) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Salla user info is missing both merchant and store identity.",
    );
  }
  const storeId = store?.id ?? merchant?.id ?? "unknown";
  const merchantId = merchant?.id ?? store?.id ?? "unknown";
  return {
    merchantId: String(merchantId),
    merchantName: merchant?.name ?? null,
    storeId: String(storeId),
    storeDomain: store?.domain ?? null,
    storeUrl: store?.url ?? null,
    storeStatus: store?.status ?? null,
  };
}

// --- Callback handling ----------------------------------------------------------

export type SallaCallbackOutcome =
  | {
      kind: "authorized";
      state: SallaOAuthState;
      grant: SallaTokenGrant;
      identity: SallaStoreIdentity;
    }
  | { kind: "user_mismatch" }
  | { kind: "project_mismatch" }
  | { kind: "provider_error"; message: string };

export async function handleSallaOAuthCallback(input: {
  request: Request;
  user: { userId: string };
  config: SallaConnectorConfig;
  publicOrigin: string;
}): Promise<{ outcome: SallaCallbackOutcome; redirectTo: string }> {
  const url = new URL(input.request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    throw new AppError("VALIDATION_ERROR", "Missing Salla OAuth state");
  }

  const state = await verifyState(stateParam, input.config.clientSecret);
  // Ownership bindings: the state's user must be the caller, and the project
  // embedded at authorize time must match the /p/:projectId return path.
  if (state.userId !== input.user.userId) {
    return {
      outcome: { kind: "user_mismatch" },
      redirectTo: state.callbackPath,
    };
  }
  const returnedProject = projectIdFromCallbackPath(state.callbackPath);
  if (returnedProject !== state.projectId) {
    return {
      outcome: { kind: "project_mismatch" },
      redirectTo: state.callbackPath,
    };
  }

  const redirectToCallback = () => state.callbackPath;

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    // Merchant declined or Salla refused install: burn the state so it can't
    // be replayed, and write no grant.
    await consumeState(state);
    return {
      outcome: { kind: "provider_error", message: errorParam },
      redirectTo: redirectToCallback(),
    };
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new AppError("VALIDATION_ERROR", "Missing Salla OAuth code");
  }

  // Single-use consumption happens BEFORE any network side effect: a replayed
  // state fails here without reaching Salla's token endpoint.
  await consumeState(state);

  const grant = await exchangeSallaAuthorizationCode({
    code,
    config: input.config,
    publicOrigin: input.publicOrigin,
  });
  const identity = await fetchSallaUserInfo({
    accessToken: grant.access_token,
  });

  return {
    outcome: { kind: "authorized", state, grant, identity },
    redirectTo: redirectToCallback(),
  };
}
