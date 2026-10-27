import { createFileRoute } from "@tanstack/react-router";
import { GoogleAdsPage } from "@/client/features/google-ads/GoogleAdsPage";

export const Route = createFileRoute("/_project/p/$projectId/google-ads")({
  component: GoogleAdsRoute,
});

function GoogleAdsRoute() {
  const { projectId } = Route.useParams();
  return <GoogleAdsPage projectId={projectId} />;
}
