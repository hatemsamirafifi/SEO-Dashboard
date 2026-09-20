import { symmetricEncrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { z } from "zod";
import { db } from "@/db";
import { account, verification } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/server/lib/errors";
import { GSC_OAUTH_PROVIDER_ID, GSC_OAUTH_SCOPES } from "@/shared/gsc";
import { GA4_OAUTH_PROVIDER_ID, GA4_OAUTH_SCOPES } from "@/shared/ga4";
import {
  getGscOAuthClientConfig,
  hasSelfHostedGscConfig,
} from "./oauth-config";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type OAuthProviderDescriptor = {
  providerId: string;
  stateKey: string;
  scopes: readonly string[];
  callbackPath: string;
  label: string;
  requireProjectState?: boolean;
};
const GSC_PROVIDER: OAuthProviderDescriptor = {
  providerId: GSC_OAUTH_PROVIDER_ID,
  stateKey: "gsc",
  scopes: GSC_OAUTH_SCOPES,
  callbackPath: "/api/gsc/oauth/callback",
  label: "Search Console",
};
const GA4_PROVIDER: OAuthProviderDescriptor = {
  providerId: GA4_OAUTH_PROVIDER_ID,
  stateKey: "ga4",
  scopes: GA4_OAUTH_SCOPES,
  callbackPath: "/api/ga4/oauth/callback",
  label: "Google Analytics",
  requireProjectState: true,
};

type SelfHostedGscUser = {
  userId: string;
  userEmail: string;
};

const oauthStateSchema = z.object({
  userId: z.string().min(1),
  callbackPath: z.string().min(1),
  exp: z.number().int(),
  projectId: z.string().min(1).optional(),
  nonce: z.string().uuid().optional(),
});

const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  token_type: z.string().optional(),
});

const googleIdTokenSchema = z.object({
  sub: z.string().min(1),
});

type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

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

async function getStateKey(clientSecret: string, stateKey: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`openseo:${stateKey}:${clientSecret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signState(
  payload: string,
  clientSecret: string,
  stateKey: string,
) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getStateKey(clientSecret, stateKey),
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
  clientSecret: string;
  userId: string;
  callbackURL: string;
  publicOrigin: string;
  provider: OAuthProviderDescriptor;
  projectId?: string;
}) {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        userId: input.userId,
        callbackPath: getSafeCallbackPath(
          input.callbackURL,
          input.publicOrigin,
        ),
        exp: Date.now() + 10 * 60 * 1_000,
        ...(input.provider.requireProjectState
          ? { projectId: input.projectId, nonce: crypto.randomUUID() }
          : {}),
      }),
    ),
  );
  const signature = await signState(
    payload,
    input.clientSecret,
    input.provider.stateKey,
  );
  const state = `${payload}.${signature}`;
  if (input.provider.requireProjectState) {
    const nonce = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload)),
    ).nonce;
    await db
      .insert(verification)
      .values({
        id: nonce,
        identifier: "ga4-oauth-state",
        value: state,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  }
  return state;
}

async function verifyState(
  state: string,
  clientSecret: string,
  provider: OAuthProviderDescriptor,
) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new AppError("VALIDATION_ERROR", "Invalid Search Console state");
  }

  const ok = await crypto.subtle.verify(
    "HMAC",
    await getStateKey(clientSecret, provider.stateKey),
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
  if (!ok) {
    throw new AppError("VALIDATION_ERROR", "Invalid Search Console state");
  }

  const parsed = oauthStateSchema.parse(
    JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))),
  );
  if (parsed.exp < Date.now()) {
    throw new AppError("VALIDATION_ERROR", "Expired Search Console state");
  }

  return parsed;
}

async function consumeGa4State(
  state: { nonce?: string; projectId?: string },
  expectedProjectId?: string,
) {
  if (
    !state.nonce ||
    !state.projectId ||
    (expectedProjectId && state.projectId !== expectedProjectId)
  )
    throw new AppError("VALIDATION_ERROR", "Invalid Google Analytics state");
  const consumed = await db
    .delete(verification)
    .where(
      and(
        eq(verification.id, state.nonce),
        eq(verification.identifier, "ga4-oauth-state"),
      ),
    )
    .returning({ id: verification.id });
  if (!consumed[0])
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Analytics state was already used",
    );
}

function projectIdFromCallbackPath(path: string): string | undefined {
  return /^\/p\/([^/?#]+)(?:\/|$)/.exec(path)?.[1];
}

function getRedirectUri(
  publicOrigin: string,
  provider: OAuthProviderDescriptor,
) {
  return `${publicOrigin}${provider.callbackPath}`;
}

function accessTokenExpiresAt(tokens: GoogleTokenResponse) {
  return new Date(Date.now() + (tokens.expires_in ?? 3600) * 1_000);
}

function storedScope(
  tokens: GoogleTokenResponse,
  provider: OAuthProviderDescriptor,
) {
  return tokens.scope
    ? tokens.scope.trim().split(/\s+/).join(",")
    : provider.scopes.join(",");
}

function getGoogleAccountId(tokens: GoogleTokenResponse) {
  if (!tokens.id_token) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google did not return an ID token for Search Console.",
    );
  }

  return googleIdTokenSchema.parse(decodeJwt(tokens.id_token)).sub;
}

async function upsertGrant(input: {
  user: SelfHostedGscUser;
  tokens: GoogleTokenResponse;
  provider: OAuthProviderDescriptor;
  projectId?: string;
}) {
  // Encrypt tokens at rest exactly the way Better Auth's setTokenUtil does
  // (same key from BETTER_AUTH_SECRET, same crypto, same encryptOAuthTokens
  // gate), so getAccessToken decrypts them on read — and so flipping the flag
  // can never desync the write and read paths.
  const ctx = await getAuth().$context;
  const encrypt = (value: string) =>
    ctx.options.account?.encryptOAuthTokens
      ? symmetricEncrypt({ key: ctx.secretConfig, data: value })
      : value;
  const googleAccountId = getGoogleAccountId(input.tokens);

  const existing = await db
    .select({ id: account.id, refreshToken: account.refreshToken })
    .from(account)
    .where(
      and(
        eq(account.userId, input.user.userId),
        eq(account.providerId, input.provider.providerId),
        eq(account.accountId, googleAccountId),
      ),
    )
    .limit(1);

  const accountValues = {
    accountId: googleAccountId,
    providerId: input.provider.providerId,
    userId: input.user.userId,
    accessToken: await encrypt(input.tokens.access_token),
    // A fresh refresh token is encrypted here; an absent one falls back to the
    // already-encrypted value stored on the existing grant.
    refreshToken: input.tokens.refresh_token
      ? await encrypt(input.tokens.refresh_token)
      : (existing[0]?.refreshToken ?? null),
    idToken: input.tokens.id_token
      ? await encrypt(input.tokens.id_token)
      : null,
    accessTokenExpiresAt: accessTokenExpiresAt(input.tokens),
    refreshTokenExpiresAt: null,
    scope: storedScope(input.tokens, input.provider),
    password: null,
  };

  if (existing[0]) {
    await db
      .update(account)
      .set({ ...accountValues, updatedAt: new Date() })
      .where(eq(account.id, existing[0].id));
    return;
  }

  await db.insert(account).values({
    id: crypto.randomUUID(),
    ...accountValues,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function exchangeCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google rejected the Search Console authorization code.",
    );
  }

  return googleTokenResponseSchema.parse(await response.json());
}

async function createSelfHostedAuthorizationUrl(input: {
  user: SelfHostedGscUser;
  callbackURL: string;
  publicOrigin: string;
  provider: OAuthProviderDescriptor;
  projectId?: string;
}) {
  const config = await getGscOAuthClientConfig();
  if (!config || !(await hasSelfHostedGscConfig())) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "Search Console is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and BETTER_AUTH_SECRET.",
    );
  }

  const redirectUri = getRedirectUri(input.publicOrigin, input.provider);
  const state = await createState({
    clientSecret: config.clientSecret,
    userId: input.user.userId,
    callbackURL: input.callbackURL,
    publicOrigin: input.publicOrigin,
    provider: input.provider,
    projectId: input.projectId,
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.provider.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("state", state);

  return url.toString();
}

export function createSelfHostedGscAuthorizationUrl(input: {
  user: SelfHostedGscUser;
  callbackURL: string;
  publicOrigin: string;
}) {
  return createSelfHostedAuthorizationUrl({ ...input, provider: GSC_PROVIDER });
}
export function createSelfHostedGa4AuthorizationUrl(input: {
  user: SelfHostedGscUser;
  callbackURL: string;
  publicOrigin: string;
  projectId: string;
}) {
  return createSelfHostedAuthorizationUrl({ ...input, provider: GA4_PROVIDER });
}

async function handleSelfHostedOAuthCallback(input: {
  request: Request;
  user: SelfHostedGscUser;
  publicOrigin: string;
  provider: OAuthProviderDescriptor;
  expectedProjectId?: string;
}) {
  const config = await getGscOAuthClientConfig();
  if (!config) {
    return new Response("Missing Google Search Console OAuth configuration", {
      status: 500,
    });
  }

  const url = new URL(input.request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    return new Response("Missing Search Console OAuth state", { status: 400 });
  }

  const state = await verifyState(
    stateParam,
    config.clientSecret,
    input.provider,
  );
  if (state.userId !== input.user.userId) {
    return new Response("Search Console OAuth user mismatch", { status: 403 });
  }
  if (input.provider.requireProjectState) {
    await consumeGa4State(
      state,
      projectIdFromCallbackPath(state.callbackPath),
    );
  }

  // state.callbackPath is a validated same-origin relative path
  // (getSafeCallbackPath). Redirect with a *relative* Location so the browser
  // resolves it against the real request origin — this avoids trusting
  // x-forwarded-host for the final hop.
  const redirectToCallback = () =>
    new Response(null, {
      status: 303,
      headers: { Location: state.callbackPath },
    });

  if (url.searchParams.get("error")) {
    return redirectToCallback();
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing Search Console OAuth code", { status: 400 });
  }

  const tokens = await exchangeCode({
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: getRedirectUri(input.publicOrigin, input.provider),
  });
  await upsertGrant({ user: input.user, tokens, provider: input.provider });

  return redirectToCallback();
}

export function handleSelfHostedGscOAuthCallback(input: {
  request: Request;
  user: SelfHostedGscUser;
  publicOrigin: string;
}) {
  return handleSelfHostedOAuthCallback({ ...input, provider: GSC_PROVIDER });
}
export function handleSelfHostedGa4OAuthCallback(input: {
  request: Request;
  user: SelfHostedGscUser;
  publicOrigin: string;
}) {
  return handleSelfHostedOAuthCallback({ ...input, provider: GA4_PROVIDER });
}
