import { createFileRoute } from "@tanstack/react-router";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ExportService } from "@/server/features/reports/services/ExportService";
import { exportFormatSchema } from "@/types/schemas/reports";

// Authenticated export download (final-plan §15): function middleware cannot
// run in API routes, so user + project scope resolve manually. Anything
// unauthenticated, unscoped, or not-ready 404s without distinguishing.
export const Route = createFileRoute("/api/report-export")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const params = new URL(request.url).searchParams;
        const reportId = params.get("reportId") ?? "";
        const format = exportFormatSchema.safeParse(params.get("format"));
        if (!reportId || !format.success) {
          return new Response("Not found", { status: 404 });
        }
        let context: { organizationId: string; userId: string };
        try {
          const resolved = await resolveUserContextFromHeaders(
            request.headers,
          );
          context = {
            organizationId: resolved.organizationId,
            userId: resolved.userId,
          };
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const projectId = params.get("projectId") ?? "";
        const project = projectId
          ? await ProjectRepository.getProjectForOrganization(
              projectId,
              context.organizationId,
            )
          : null;
        if (!project) return new Response("Not found", { status: 404 });
        const download = await ExportService.downloadExport({
          reportId,
          projectId: project.id,
          format: format.data,
        });
        if (!download) return new Response("Not found", { status: 404 });
        const inline = format.data === "html";
        return new Response(download.body, {
          headers: {
            "content-type": download.contentType,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename="${download.fileName}"`,
          },
        });
      },
    },
  },
});
