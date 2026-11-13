import { runWithDataforseoContext } from "@/server/lib/dataforseo/context";

// Light module (no SDK, no DB imports at load time — the settings service is
// resolved dynamically exactly like core.ts does) so the rank-check workflow
// and its tests can bind an account scope without dragging the billing stack
// into the import graph.

/**
 * Bind a scope's EFFECTIVE DataForSEO settings (project -> org -> env
 * precedence) into the request context for `fn`, so every SDK call inside
 * resolves the exact same account — the authenticated fetch hits its
 * context fast-path and never re-resolves settings. Used by the rank-check
 * COLLECTION path (task_get): it must hit the same account that the metered
 * task_post used, including project-level credential overrides, while
 * staying unmetered (task_get is free at DataForSEO; no double billing).
 *
 * When the scope has no configured credentials, only the org/project ids are
 * bound and the fetch falls back through its own resolution (same settings
 * precedence for that scope, then env).
 */
export async function runWithDataforseoAccountContext<T>(
  input: { organizationId: string | null; projectId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  const { resolveEffectiveDataforseoConfig } =
    await import("@/server/features/settings/services/DataforseoSettingsService");
  const { login, password } = await resolveEffectiveDataforseoConfig(input);
  return runWithDataforseoContext(
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      ...(login && password ? { login, password } : {}),
    },
    fn,
  );
}
