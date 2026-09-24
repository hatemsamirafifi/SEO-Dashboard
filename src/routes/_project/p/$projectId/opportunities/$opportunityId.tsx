import { createFileRoute } from "@tanstack/react-router";
import { OpportunityDetail } from "@/client/features/opportunities/OpportunityDetail";

export const Route = createFileRoute(
  "/_project/p/$projectId/opportunities/$opportunityId",
)({
  component: OpportunityDetailRoute,
});

function OpportunityDetailRoute() {
  const { projectId, opportunityId } = Route.useParams();
  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl">
        <OpportunityDetail
          projectId={projectId}
          opportunityId={opportunityId}
        />
      </div>
    </div>
  );
}
