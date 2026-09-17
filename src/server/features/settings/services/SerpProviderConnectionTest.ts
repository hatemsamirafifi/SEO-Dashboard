import {
  closeProviderCircuit,
  fingerprintProviderCredential,
  getProviderCircuitState,
  openProviderCircuit,
  type ProviderCircuitIdentity,
} from "@/server/features/serp/circuitBreaker";
import { resolveEffectiveSerpProviderConfig } from "@/server/features/settings/services/SerpProviderSettingsService";

export type SerpProviderConnectionTestResult = {
  ok: boolean;
  status: number;
  reason:
    | "CONNECTED"
    | "INVALID_CREDENTIALS"
    | "QUOTA_EXHAUSTED"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
    | "NOT_CONFIGURED";
  durationMs: number;
  consumesQuery: true;
};

function classifyStatus(
  status: number,
  body: string,
): SerpProviderConnectionTestResult["reason"] {
  if (status === 401 || status === 403) return "INVALID_CREDENTIALS";
  if (status === 429 && /credit|quota|exhaust/i.test(body))
    return "QUOTA_EXHAUSTED";
  if (status === 429) return "RATE_LIMITED";
  return "UNAVAILABLE";
}

export async function testSerpProviderConnection(input: {
  provider: "serper" | "zenserp";
  organizationId: string;
  projectId?: string | null;
  apiKey?: string;
  fetchFn?: typeof fetch;
}): Promise<SerpProviderConnectionTestResult> {
  const effective = await resolveEffectiveSerpProviderConfig(input);
  const apiKey = input.apiKey?.trim() || effective.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      reason: "NOT_CONFIGURED",
      durationMs: 0,
      consumesQuery: true,
    };
  }
  const circuitIdentity: ProviderCircuitIdentity = {
    provider: input.provider,
    organizationId: input.organizationId,
    projectId:
      input.projectId &&
      (input.apiKey?.trim() || effective.source === "project")
        ? input.projectId
        : null,
    credentialFingerprint: await fingerprintProviderCredential(input.provider, [
      apiKey,
    ]),
  };
  const failed = (
    result: SerpProviderConnectionTestResult,
  ): SerpProviderConnectionTestResult => {
    const deterministic = ["INVALID_CREDENTIALS", "QUOTA_EXHAUSTED"].includes(
      result.reason,
    );
    if (deterministic || getProviderCircuitState(circuitIdentity)) {
      openProviderCircuit(circuitIdentity, result.reason);
    }
    return result;
  };
  const startedAt = Date.now();
  try {
    const response =
      input.provider === "serper"
        ? await (input.fetchFn ?? fetch)("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: "OpenSEO", num: 1, gl: "us", hl: "en" }),
            signal: AbortSignal.timeout(15_000),
          })
        : await (input.fetchFn ?? fetch)(
            "https://app.zenserp.com/api/v2/search?q=OpenSEO&engine=google&num=1&gl=us&hl=en",
            {
              headers: { apikey: apiKey, Accept: "application/json" },
              signal: AbortSignal.timeout(15_000),
            },
          );
    const body = await response.text();
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return failed({
        ok: false,
        status: response.status,
        reason: classifyStatus(response.status, body),
        durationMs,
        consumesQuery: true,
      });
    }
    try {
      JSON.parse(body);
    } catch {
      return failed({
        ok: false,
        status: response.status,
        reason: "UNAVAILABLE",
        durationMs,
        consumesQuery: true,
      });
    }
    closeProviderCircuit(circuitIdentity);
    return {
      ok: true,
      status: response.status,
      reason: "CONNECTED",
      durationMs,
      consumesQuery: true,
    };
  } catch {
    return failed({
      ok: false,
      status: 503,
      reason: "UNAVAILABLE",
      durationMs: Date.now() - startedAt,
      consumesQuery: true,
    });
  }
}