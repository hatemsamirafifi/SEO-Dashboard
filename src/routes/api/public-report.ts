import { createFileRoute } from "@tanstack/react-router";
import { ShareService } from "@/server/features/reports/services/ShareService";

// Sole unauthenticated JSON surface (final-plan §15): token-hash lookup
// only. The page bundle cannot import server code, so the public `r/$token`
// page fetches this endpoint instead of calling the service directly.
//
// FR-002 (spec 005): invalid/revoked/expired are DISTINGUISHABLE without
// leaking internals — the resolution state rides the `X-Share-State` header;
// every non-active state carries ZERO report content (fail closed).
export const Route = createFileRoute("/api/public-report")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const resolution = await ShareService.resolvePublicShare(token);
        if (resolution.state !== "active") {
          return new Response("Not found", {
            status: 404,
            headers: {
              "X-Share-State": resolution.state,
              "Cache-Control": "no-store",
            },
          });
        }
        return Response.json(resolution.view, {
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
