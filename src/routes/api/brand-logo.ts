import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

// Public logo delivery for shared reports (branding keys are unguessable
// content hashes, so no auth is needed). The key pattern is locked to the
// branding prefix — anything else 404s without touching storage.
const BRAND_LOGO_KEY_PATTERN =
  /^branding\/[A-Za-z0-9_-]+\/[0-9a-f]{64}\.(png|jpe?g)$/;

function contentTypeFor(key: string): string {
  return key.endsWith(".png") ? "image/png" : "image/jpeg";
}

export const Route = createFileRoute("/api/brand-logo")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const key = new URL(request.url).searchParams.get("key") ?? "";
        if (!BRAND_LOGO_KEY_PATTERN.test(key)) {
          return new Response("Not found", { status: 404 });
        }
        const object = await env.R2.get(key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "content-type": contentTypeFor(key),
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
