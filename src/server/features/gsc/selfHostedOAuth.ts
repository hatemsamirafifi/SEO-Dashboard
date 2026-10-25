/* eslint-disable max-lines */
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
  GOOGLE_ADS_OAUTH_PROVIDER_ID,
  GOOGLE_ADS_OAUTH_SCOPES,
} from "@/shared/google-ads";
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
  /** Approved single-use state identifier in better-auth's verification
   *  table. Providers without project-bound nonce rows never store there. */
  stateIdentifier: string;
  /** PKCE (S256) for providers whose Google scopes are sensitive. The
   *  code_verifier lives only in the single-use state row — never in the
   *  authorization URL — and is replayed once, at the token exchange. */
  pkce?: boolean;
};
const GSC_PROVIDER: OAuthProviderDescriptor = {
  providerId: GSC_OAUTH_PROVIDER_ID,
  stateKey: "gsc",
  scopes: GSC_OAUTH_SCOPES,
  callbackPath: "/api/gsc/oauth/callback",
  label: "Search Console",
  stateIdentifier: "gsc-oauth-state",
};
const GA4_PROVIDER: OAuthProviderDescriptor = {
  providerId: GA4_OAUTH_PROVIDER_ID,
  stateKey: "ga4",
  scopes: GA4_OAUTH_SCOPES,
  callbackPath: "/api/ga4/oauth/callback",
  label: "Google Analytics",
  requireProjectState: true,
  stateIdentifier: "ga4-oauth-state",
};
const GOOGLE_ADS_PROVIDER: OAuthProviderDescriptor = {
  providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
  stateKey: "google-ads",
  scopes: GOOGLE_ADS_OAUTH_SCOPES,
  callbackPath: "/api/google-ads/oauth/callback",
  label: "Google Ads",
  requireProjectState: true,
  stateIdentifier: "google-ads-oauth-state",
  pkce: true,
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

type OAuthState = z.infer<typeof oauthStateSchema>;

/** How long a signed state stays usable. */
const STATE_TTL_MS = 10 * 60 * 1_000;

/** Parses JSON text into an unknown value so a schema can narrow it. */
function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

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
  const callbackPath = getSafeCallbackPath(
    input.callbackURL,
    input.publicOrigin,
  );
  const exp = Date.now() + STATE_TTL_MS;
  const nonce = input.provider.requireProjectState ? crypto.randomUUID() : null;
  // Type the state before it is signed: the signed payload, the single-use
  // row id, and the parked PKCE verifier all derive from these validated
  // values, so nothing has to be re-parsed out of the encoded payload.
  const stateData: OAuthState = oauthStateSchema.parse({
    userId: input.userId,
    callbackPath,
    exp,
    ...(nonce ? { projectId: input.projectId, nonce } : {}),
  });
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(stateData)),
  );
  const signature = await signState(
    payload,
    input.clientSecret,
    input.provider.stateKey,
  );
  const state = `${payload}.${signature}`;
  let codeVerifier: string | null = null;
  if (nonce) {
    // PKCE providers park the code_verifier in the same single-use row the
    // nonce guards: it exists exactly once, expires with the state, and is
    // consumed by the callback that proves possession of the signed state.
    if (input.provider.pkce) {
      codeVerifier = generateCodeVerifier();
    }
    const value = codeVerifier
      ? JSON.stringify({ state, codeVerifier })
      : state;
    await db.insert(verification).values({
      id: nonce,
      identifier: input.provider.stateIdentifier,
      value,
      expiresAt: new Date(exp),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return { state, codeVerifier };
}

/** RFC 7636 §4.1 verifier: 43+ base64url chars from system entropy. */
function generateCodeVerifier() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function codeChallengeFor(verifier: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((digest) => bytesToBase64Url(new Uint8Array(digest)));
}

/** Single-use state row: deletes atomically and returns the parked PKCE
 *  verifier (pkce providers only). */
async function consumeProjectBoundState(
  rawState: string,
  state: { nonce?: string; projectId?: string },
  provider: OAuthProviderDescriptor,
  expectedProjectId?: string,
): Promise<{ codeVerifier: string } | null> {
  if (
    !state.nonce ||
    !state.projectId ||
    (expectedProjectId && state.projectId !== expectedProjectId)
  )
    throw new AppError("VALIDATION_ERROR", `Invalid ${provider.label} state`);
  const consumed = await db
    .delete(verification)
    .where(
      and(
        eq(verification.id, state.nonce),
        eq(verification.identifier, provider.stateIdentifier),
      ),
    )
    .returning({ id: verification.id, value: verification.value });
  if (!consumed[0]) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${provider.label} state was already used`,
    );
  }
  if (!provider.pkce) return null;
  const pkceValue = pkceValueSchema.parse(parseJson(consumed[0].value));
  // The parked state must be the exact signed state that was presented here.
  if (pkceValue.state !== rawState)
    throw new AppError("VALIDATION_ERROR", `Invalid ${provider.label} state`);
  return { codeVerifier: pkceValue.codeVerifier };
}

const pkceValueSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

async function verifyState(
  state: string,
  clientSecret: string,
  provider: OAuthProviderDescriptor,
) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${provider.label} state`);
  }

  const ok = await crypto.subtle.verify(
    "HMAC",
    await getStateKey(clientSecret, provider.stateKey),
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
  if (!ok) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${provider.label} state`);
  }

  const parsed = oauthStateSchema.parse(
    parseJson(new TextDecoder().decode(base64UrlToBytes(payload))),
  );
  if (parsed.exp < Date.now()) {
    throw new AppError("VALIDATION_ERROR", `Expired ${provider.label} state`);
  }

  return parsed;
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

function getGoogleAccountId(
  tokens: GoogleTokenResponse,
  provider: OAuthProviderDescriptor,
) {
  if (!tokens.id_token) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Google did not return an ID token for ${provider.label}.`,
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
  const googleAccountId = getGoogleAccountId(input.tokens, input.provider);

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
  codeVerifier?: string;
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
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    }),
  });

  if (!response.ok) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google rejected the authorization code.",
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
  const { state, codeVerifier } = await createState({
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
  if (input.provider.pkce && codeVerifier) {
    // Only the challenge travels in the URL; the verifier stays parked in
    // the single-use state row until its one callback consumes it.
    url.searchParams.set(
      "code_challenge",
      await codeChallengeFor(codeVerifier),
    );
    url.searchParams.set("code_challenge_method", "S256");
  }

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
    return new Response("Missing Google OAuth configuration", {
      status: 500,
    });
  }

  const url = new URL(input.request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    return new Response(`Missing ${input.provider.label} OAuth state`, {
      status: 400,
    });
  }

  const state = await verifyState(
    stateParam,
    config.clientSecret,
    input.provider,
  );
  if (state.userId !== input.user.userId) {
    return new Response(`${input.provider.label} OAuth user mismatch`, {
      status: 403,
    });
  }
  let pkce: { codeVerifier: string } | null = null;
  if (input.provider.requireProjectState) {
    pkce = await consumeProjectBoundState(
      stateParam,
      state,
      input.provider,
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
    return new Response(`Missing ${input.provider.label} OAuth code`, {
      status: 400,
    });
  }

  const tokens = await exchangeCode({
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: getRedirectUri(input.publicOrigin, input.provider),
    ...(pkce?.codeVerifier ? { codeVerifier: pkce.codeVerifier } : {}),
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

export function createSelfHostedGoogleAdsAuthorizationUrl(input: {
  user: SelfHostedGscUser;
  callbackURL: string;
  publicOrigin: string;
  projectId: string;
}) {
  return createSelfHostedAuthorizationUrl({
    ...input,
    provider: GOOGLE_ADS_PROVIDER,
  });
}
export function handleSelfHostedGoogleAdsOAuthCallback(input: {
  request: Request;
  user: SelfHostedGscUser;
  publicOrigin: string;
}) {
  return handleSelfHostedOAuthCallback({
    ...input,
    provider: GOOGLE_ADS_PROVIDER,
  });
}
