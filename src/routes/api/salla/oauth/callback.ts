import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import { resolveCloudflareAccessContext } from "@/middleware/ensure-user/cloudflareAccess";
import { resolveLocalNoAuthContext } from "@/middleware/ensure-user/delegated";
import { responseForAppError } from "@/server/lib/http-errors";
import { SallaService } from "@/server/features/salla/sallaService";
import { getPublicOrigin } from "@/server/mcp/public-origin";

async function resolveContext(request: Request) {
  const authMode = getAuthMode(env.AUTH_MODE);

  if (isHostedAuthMode(authMode)) return null;

  return authMode === "local_noauth"
    ? resolveLocalNoAuthContext()
    : resolveCloudflareAccessContext(request.headers);
}

function redirectResponse(location: string) {
  // Relative Location only: the browser resolves it against the real request
  // origin, so a malicious callback can never bounce to a foreign host.
  return new Response(null, {
    status: 303,
    headers: { Location: location },
  });
}

async function handleCallbackRequest(request: Request) {
  try {
    const context = await resolveContext(request);
    if (!context) return new Response("Not found", { status: 404 });

    const result = await SallaService.completeCallback({
      request,
      user: { userId: context.userId },
      organizationId: context.organizationId,
      publicOrigin: getPublicOrigin(request),
    });
    if (result.outcome.kind !== "authorized") {
      // Same as the audited flows: mismatch/decline responses never carry
      // token material back to the browser.
      return redirectResponse(result.redirectTo);
    }
    return redirectResponse(result.redirectTo);
  } catch (error) {
    return responseForAppError(error, "Salla OAuth failed");
  }
}

export const Route = createFileRoute("/api/salla/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return handleCallbackRequest(request);
      },
    },
  },
});
