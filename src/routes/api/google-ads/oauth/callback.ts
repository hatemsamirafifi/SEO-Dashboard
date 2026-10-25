import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import { resolveCloudflareAccessContext } from "@/middleware/ensure-user/cloudflareAccess";
import { resolveLocalNoAuthContext } from "@/middleware/ensure-user/delegated";
import { handleSelfHostedGoogleAdsOAuthCallback } from "@/server/features/gsc/selfHostedOAuth";
import { responseForAppError } from "@/server/lib/http-errors";
import { getPublicOrigin } from "@/server/mcp/public-origin";

export const Route = createFileRoute("/api/google-ads/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        try {
          const mode = getAuthMode(env.AUTH_MODE);
          if (isHostedAuthMode(mode))
            return new Response("Not found", { status: 404 });
          const context =
            mode === "local_noauth"
              ? await resolveLocalNoAuthContext()
              : await resolveCloudflareAccessContext(request.headers);
          if (!context) return new Response("Not found", { status: 404 });
          return await handleSelfHostedGoogleAdsOAuthCallback({
            request,
            user: { userId: context.userId, userEmail: context.userEmail },
            publicOrigin: getPublicOrigin(request),
          });
        } catch (error) {
          return responseForAppError(error, "Google Ads OAuth failed");
        }
      },
    },
  },
});
