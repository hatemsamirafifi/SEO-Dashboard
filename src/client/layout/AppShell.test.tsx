import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedAppLayout } from "./AppShell";

const mocks = vi.hoisted(() => ({
  routeId: "/_project/p/$projectId/domain",
  status: undefined as { enabled: boolean; configured: boolean } | undefined,
  statusFailed: false,
  fetching: false,
  query: vi.fn(),
  skipToken: Symbol("skip status"),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useLocation: () => ({ pathname: "/p/test-project/domain" }),
  useMatches: (options: {
    select: (matches: { routeId: string }[]) => boolean;
  }) => options.select([{ routeId: mocks.routeId }]),
}));
vi.mock("@tanstack/react-query", () => ({
  skipToken: mocks.skipToken,
  useQuery: (options: { queryKey: string[]; queryFn: unknown }) => {
    if (options.queryKey[0] === "projects") return {};
    mocks.query(options);
    return {
      data: mocks.status,
      isSuccess: !!mocks.status && !mocks.statusFailed,
      isFetching: mocks.fetching,
    };
  },
}));
vi.mock("@/client/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/client/navigation/items", () => ({ dataforseoHelpLinkOptions: {} }));
vi.mock("@/client/features/gsc/GscReEngagementModal", () => ({
  GscReEngagementModal: () => null,
}));
vi.mock("@/client/features/tracing/GlobalDebugTracePanel", () => ({
  GlobalDebugTracePanel: () => null,
}));
vi.mock("@/client/features/tracing/useGlobalTrace", () => ({
  useGlobalTrace: () => ({ panelOpen: false }),
}));
vi.mock("@/serverFunctions/config", () => ({ getSeoApiKeyStatus: vi.fn() }));
vi.mock("@/serverFunctions/projects", () => ({ getProjects: vi.fn() }));

function renderShell() {
  return renderToStaticMarkup(
    <AuthenticatedAppLayout projectId="test-project">
      Content
    </AuthenticatedAppLayout>,
  );
}

describe("project DataForSEO setup notice", () => {
  beforeEach(() => {
    mocks.routeId = "/_project/p/$projectId/domain";
    mocks.status = { enabled: true, configured: false };
    mocks.statusFailed = false;
    mocks.fetching = false;
  });

  it.each(["domain", "backlinks"])(
    "prompts for an enabled but missing key on %s",
    (route) => {
      mocks.routeId = `/_project/p/$projectId/${route}`;
      const html = renderShell();
      expect(html).toContain('role="dialog"');
      expect(html).toContain("Set up DataForSEO");
      expect(mocks.query).toHaveBeenCalledWith({
        queryKey: ["seoApiKeyStatus", "test-project"],
        queryFn: expect.any(Function),
      });
    },
  );

  it.each([
    "keywords",
    "search-performance",
    "google-ads",
    "rank-tracking",
    "settings",
  ])(
    "skips the status query and notices on %s even with a cached enabled status",
    (route) => {
      mocks.routeId = `/_project/p/$projectId/${route}`;
      expect(renderShell()).not.toContain("DataForSEO");
      expect(mocks.query).toHaveBeenCalledWith({
        queryKey: ["seoApiKeyStatus", "test-project"],
        queryFn: mocks.skipToken,
      });
    },
  );

  it.each([
    ["disabled", { enabled: false, configured: false }],
    ["configured", { enabled: true, configured: true }],
    ["unknown", undefined],
  ] as const)(
    "hides the notice when status is %s on a relevant route",
    (_label, status) => {
      mocks.status = status;
      expect(renderShell()).not.toContain("DataForSEO");
    },
  );

  it("suppresses cached warnings during a refresh and after an unsuccessful status check", () => {
    mocks.fetching = true;
    expect(renderShell()).not.toContain("DataForSEO");
    mocks.fetching = false;
    mocks.statusFailed = true;
    expect(renderShell()).not.toContain("DataForSEO");
  });
});
