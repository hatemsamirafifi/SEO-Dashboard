import { createFileRoute } from "@tanstack/react-router";
import { PublicReportPage } from "@/client/features/reports/PublicReportPage";

export const Route = createFileRoute("/r/$token")({
  component: PublicReportRoute,
});

function PublicReportRoute() {
  const { token } = Route.useParams();
  return <PublicReportPage token={token} />;
}
