import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_project/p/$projectId/reports")({
  component: ReportsLayout,
});

function ReportsLayout() {
  return <Outlet />;
}
