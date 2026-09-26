const COOLDOWN_MS = 30 * 60 * 1000;

export type ProviderCircuitIdentity = {
  provider: string;
  organizationId?: string | null;
  projectId?: string | null;
  credentialFingerprint?: string | null;
};

export type ProviderCircuitState = {
  provider: string;
  state: "open";
  openedAt: number;
  expiresAt: number;
  reason: string;
};

export type ProviderCircuitView = {
  state: "closed" | "open";
  openedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  retryAfterMs: number | null;
};

// This is deliberately runtime-local state. It prevents repeated calls only
// within the current process/worker; another instance may retry the provider.
// A distributed circuit would require shared durable storage and coordination.
const circuits = new Map<string, ProviderCircuitState>();

function key(identity: ProviderCircuitIdentity) {
  return [
    identity.organizationId ?? "environment",
    identity.projectId ?? "organization",
    identity.provider,
    identity.credentialFingerprint ?? "unconfigured",
  ].join(":");
}

export async function fingerprintProviderCredential(
  provider: string,
  credentialParts: Array<string | null | undefined>,
): Promise<string | null> {
  const normalized = credentialParts.map((part) => part?.trim() ?? "");
  if (normalized.every((part) => part.length === 0)) return null;
  const payload = new TextEncoder().encode(
    `${provider}\u0000${normalized.join("\u0000")}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getProviderCircuitState(
  identity: ProviderCircuitIdentity,
  now = Date.now(),
): ProviderCircuitState | null {
  const circuitKey = key(identity);
  const state = circuits.get(circuitKey);
  if (!state) return null;
  if (state.expiresAt <= now) {
    circuits.delete(circuitKey);
    return null;
  }
  return { ...state };
}

export function getProviderCircuitView(
  identity: ProviderCircuitIdentity,
  now = Date.now(),
): ProviderCircuitView {
  const state = getProviderCircuitState(identity, now);
  if (!state) {
    return {
      state: "closed",
      openedAt: null,
      expiresAt: null,
      reason: null,
      retryAfterMs: null,
    };
  }
  return {
    state: "open",
    openedAt: new Date(state.openedAt).toISOString(),
    expiresAt: new Date(state.expiresAt).toISOString(),
    reason: state.reason,
    retryAfterMs: Math.max(0, state.expiresAt - now),
  };
}

export function openProviderCircuit(
  identity: ProviderCircuitIdentity,
  reason: string,
  now = Date.now(),
) {
  circuits.set(key(identity), {
    provider: identity.provider,
    state: "open",
    openedAt: now,
    expiresAt: now + COOLDOWN_MS,
    reason,
  });
}

export function closeProviderCircuit(identity: ProviderCircuitIdentity) {
  circuits.delete(key(identity));
}

export function resetProviderCircuitsForTests() {
  circuits.clear();
}
