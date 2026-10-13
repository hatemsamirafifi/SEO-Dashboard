// Maintainer-only guard for internal diagnostic and spike surfaces.
// Ensures developer/maintainer tools remain invisible to regular end users.

type MaintainerCheckOptions = {
  searchParams?: URLSearchParams | null;
  storage?: Pick<Storage, "getItem"> | null;
  isDev?: boolean;
};

export function isMaintainerSurfaceEnabled(
  options?: MaintainerCheckOptions,
): boolean {
  const isDev =
    options?.isDev ??
    (typeof import.meta !== "undefined" &&
      Boolean(
        import.meta.env?.DEV || import.meta.env?.VITE_MAINTAINER_MODE === "1",
      ));
  if (isDev) return true;

  try {
    const searchParams =
      options?.searchParams ??
      (typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null);
    if (searchParams) {
      const val = searchParams.get("maintainer");
      if (val === "1" || val === "true") return true;
    }
  } catch {
    // ignore
  }

  try {
    const storage =
      options?.storage ??
      (typeof window !== "undefined" ? window.localStorage : null);
    if (storage) {
      const item = storage.getItem("openseo:maintainer_mode");
      if (item === "1" || item === "true") return true;
    }
  } catch {
    // ignore
  }

  return false;
}
