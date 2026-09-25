import { createFileRoute } from "@tanstack/react-router";
import { ShareService } from "@/server/features/reports/services/ShareService";

// Sole unauthenticated JSON surface (final-plan §15): token-hash lookup
// only. The page bundle cannot import server code, so the public `r/$token`
// page fetches this endpoint instead of calling the service directly.
export const Route = createFileRoute("/api/public-report")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const view = await ShareService.getPublicReportByToken(token);
        if (!view) return new Response("Not found", { status: 404 });
        return Response.json(view);
      },
    },
  },
});
