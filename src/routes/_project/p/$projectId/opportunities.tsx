import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_project/p/$projectId/opportunities")({
  component: OpportunitiesLayout,
});

function OpportunitiesLayout() {
  return <Outlet />;
}
