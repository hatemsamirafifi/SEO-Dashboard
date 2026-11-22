import * as React from "react";
import { Link, useLocation, useMatches } from "@tanstack/react-router";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";
import {
  MissingSeoSetupModal,
  MobileSidebarDrawer,
  SeoApiSetupBanner,
} from "@/client/layout/AppShellParts";
import { GscReEngagementModal } from "@/client/features/gsc/GscReEngagementModal";
import { Sidebar } from "@/client/components/Sidebar";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import { getProjects } from "@/serverFunctions/projects";
import { getLastProjectId } from "@/client/lib/active-project";
import { GlobalDebugTracePanel } from "@/client/features/tracing/GlobalDebugTracePanel";
import { useGlobalTrace } from "@/client/features/tracing/useGlobalTrace";

export function AuthenticatedAppLayout({
  children,
  projectId,
  banner,
}: {
  children: React.ReactNode;
  projectId?: string;
  banner?: React.ReactNode;
}) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const setupModalRef = React.useRef<HTMLDivElement | null>(null);
  const [setupDismissedOn, setSetupDismissedOn] = React.useState<string | null>(
    null,
  );
  // On non-project pages (e.g. /settings) there's no projectId in the URL, so
  // derive one for the nav/switcher: prefer the last-visited project, else the
  // most recent. The whole app tree is client-only (see root ClientOnly), so we
  // can read localStorage synchronously during the first render — this lets the
  // sidebar show the full project nav on the very first paint instead of briefly
  // flashing only the always-visible Connect group while projects load.
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    enabled: !projectId,
  });
  const [rememberedProjectId] = React.useState<string | null>(() =>
    getLastProjectId(),
  );
  const fallbackProjects = projectsQuery.data ?? [];
  const fallbackProjectId =
    fallbackProjects.find((project) => project.id === rememberedProjectId)
      ?.id ??
    fallbackProjects[0]?.id ??
    null;
  // Once the projects list loads, fallbackProjectId is the validated choice
  // (remembered-if-valid, else most recent). Before it loads, fall back to the
  // remembered id so the project nav renders immediately; a stale id here only
  // builds links that self-correct via the route guard once data arrives.
  const sidebarProjectId =
    projectId ?? fallbackProjectId ?? rememberedProjectId;
  const { panelOpen, setPanelOpen } = useGlobalTrace();
  const usesCompetitiveResearch = useMatches({
    select: (matches) =>
      matches.some(
        ({ routeId }) =>
          routeId === "/_project/p/$projectId/domain" ||
          routeId === "/_project/p/$projectId/backlinks",
      ),
  });
  const seoApiKeyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus", projectId],
    queryFn:
      usesCompetitiveResearch && projectId
        ? () => getSeoApiKeyStatus({ data: { projectId } })
        : skipToken,
  });
  const needsDataForSeoSetup =
    usesCompetitiveResearch &&
    !!projectId &&
    seoApiKeyStatusQuery.isSuccess &&
    !seoApiKeyStatusQuery.isFetching &&
    seoApiKeyStatusQuery.data.enabled &&
    !seoApiKeyStatusQuery.data.configured;
  const shouldShowMissingSeoApiKeyModal =
    needsDataForSeoSetup && setupDismissedOn !== location.pathname;

  React.useEffect(() => {
    if (!shouldShowMissingSeoApiKeyModal) return;

    setupModalRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSetupDismissedOn(location.pathname);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [location.pathname, shouldShowMissingSeoApiKeyModal]);

  return (
    <div className="flex h-[100dvh] bg-base-200">
      <div className="hidden shrink-0 md:block">
        <Sidebar projectId={sidebarProjectId} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar
          drawerOpen={drawerOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
        />

        {/* PostHog-style cutout: the main content sits on a raised panel with a
            thin strip of the sidebar background above it and a hairline border. */}
        <div className="flex min-h-0 flex-1 flex-col md:pt-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-base-100 md:rounded-tl-lg md:border-l md:border-t md:border-base-300">
            {needsDataForSeoSetup && !shouldShowMissingSeoApiKeyModal ? (
              <SeoApiSetupBanner />
            ) : null}

            {banner}

            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </div>
        </div>
      </div>

      <MobileSidebarDrawer
        open={drawerOpen}
        projectId={sidebarProjectId}
        onClose={() => setDrawerOpen(false)}
      />

      <MissingSeoSetupModal
        ref={setupModalRef}
        isOpen={shouldShowMissingSeoApiKeyModal}
        onClose={() => setSetupDismissedOn(location.pathname)}
      />

      <GscReEngagementModal
        projectId={sidebarProjectId}
        suppressed={shouldShowMissingSeoApiKeyModal}
      />

      {panelOpen && (
        <GlobalDebugTracePanel
          projectId={projectId}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

function MobileTopBar({
  drawerOpen,
  onOpenDrawer,
}: {
  drawerOpen: boolean;
  onOpenDrawer: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-2 py-1.5 md:hidden">
      <button
        type="button"
        className="btn btn-square btn-ghost btn-sm"
        aria-label="Toggle sidebar"
        aria-expanded={drawerOpen}
        onClick={onOpenDrawer}
      >
        <Menu className="h-5 w-5" />
      </button>
      <Link to="/" className="ml-1 font-semibold text-base-content">
        OpenSEO
      </Link>
    </div>
  );
}
