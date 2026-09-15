const COOLDOWN_MS = 30 * 60 * 1000;

// This is deliberately runtime-local state. It prevents repeated calls only
// within the current process/worker; another instance may retry the provider.
// A distributed circuit would require shared durable storage and coordination.
const circuits = new Map<string, number>();

function key(
  provider: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  return `${organizationId ?? "env"}:${projectId ?? "org"}:${provider}`;
}

export function isProviderCircuitOpen(
  provider: string,
  organizationId?: string | null,
  projectId?: string | null,
  now = Date.now(),
): boolean {
  const expires = circuits.get(key(provider, organizationId, projectId));
  if (!expires) return false;
  if (expires <= now) {
    circuits.delete(key(provider, organizationId, projectId));
    return false;
  }
  return true;
}

export function openProviderCircuit(
  provider: string,
  organizationId?: string | null,
  projectId?: string | null,
  now = Date.now(),
) {
  circuits.set(key(provider, organizationId, projectId), now + COOLDOWN_MS);
}

export function closeProviderCircuit(
  provider: string,
  organizationId?: string | null,
  projectId?: string | null,
) {
  circuits.delete(key(provider, organizationId, projectId));
}

export function resetProviderCircuitsForTests() {
  circuits.clear();
}
