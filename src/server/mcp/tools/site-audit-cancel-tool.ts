import { z } from "zod";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { captureServerEvent } from "@/server/lib/posthog";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

export const cancelAuditTool = {
  name: "cancel_site_audit",
  config: {
    title: "Cancel a site audit",
    description:
      "Cancel a running site audit. The crawl stops between batches and the pages fetched so far are preserved with a cancelled status (partial results, not a complete report).",
    inputSchema: {
      projectId: projectIdSchema,
      auditId: z
        .string()
        .describe("Audit ID to cancel. Must currently be running."),
    },
    outputSchema: z
      .object({
        auditId: z.string(),
        status: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: { projectId: string; auditId: string }, context) => {
      const result = await AuditService.cancelAudit({
        actorUserId: context.auth.userId,
        auditId: args.auditId,
        projectId: args.projectId,
      });

      await captureServerEvent({
        distinctId: context.auth.userId,
        event: "site_audit:cancel",
        organizationId: context.auth.organizationId,
        properties: {
          project_id: args.projectId,
          status: result.status ?? "cancelled",
          source: "mcp",
        },
      });

      return mcpResponse({
        text: `Audit ${result.auditId} is ${result.status ?? "cancelling"}. Poll get_audit_status until the workflow finalizes, then read pages via get_audit_pages.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit?auditId=${result.auditId}`,
        ),
        structuredContent: {
          auditId: result.auditId,
          status: result.status ?? "cancelled",
        },
      });
    },
  ),
};
