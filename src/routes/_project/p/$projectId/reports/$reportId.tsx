import { createFileRoute } from "@tanstack/react-router";
import { ReportDetail } from "@/client/features/reports/ReportDetail";

export const Route = createFileRoute(
  "/_project/p/$projectId/reports/$reportId",
)({
  component: ReportDetailRoute,
});

function ReportDetailRoute() {
  const { projectId, reportId } = Route.useParams();
  return <ReportDetail projectId={projectId} reportId={reportId} />;
}
