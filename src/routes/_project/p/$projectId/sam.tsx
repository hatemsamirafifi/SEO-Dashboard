import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SamChat } from "@/client/features/sam/SamChat";

const samSearchSchema = z.object({
  // Active session id. Omitted until a session is selected/created.
  s: z.string().optional(),
  // Active SAM sub-tab. Defaults to "chat" when omitted.
  tab: z.enum(["chat", "actions", "autopilot"]).optional(),
});

export const Route = createFileRoute("/_project/p/$projectId/sam")({
  validateSearch: samSearchSchema,
  component: SamRoute,
});

function SamRoute() {
  const { projectId } = Route.useParams();
  const { s, tab } = Route.useSearch();
  return <SamChat projectId={projectId} activeSessionId={s} activeTab={tab} />;
}
