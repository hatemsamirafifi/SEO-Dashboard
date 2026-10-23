import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import type { PageSchemaResult } from "@/server/features/audit/services/SchemaService";
import { AppError } from "@/server/lib/errors";
import { SCHEMA_ENTITY_TYPES } from "@/shared/schema-types";
import { buildProjectMeta } from "@/server/mcp/context";
import { instrumentMcpToolHandler } from "@/server/mcp/instrumentation";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { auditPath, resolveAudit } from "@/server/mcp/tools/site-audit-shared";

const getPageSchemaInputSchema = {
  projectId: projectIdSchema,
  auditId: z
    .string()
    .optional()
    .describe("Audit ID. If omitted, uses the project's most recent audit."),
  pageId: z
    .string()
    .min(1)
    .describe("Page ID from get_audit_pages for the audited page."),
  type: z
    .enum(SCHEMA_ENTITY_TYPES)
    .optional()
    .describe(
      "Schema type to propose. Omit to list which types this page can generate.",
    ),
} as const;

type GetPageSchemaArgs = z.infer<z.ZodObject<typeof getPageSchemaInputSchema>>;

function renderPageSchema(result: PageSchemaResult): string {
  const lines = [
    `Page ${result.page.url} (${result.page.pageType ?? "unclassified"}, ${result.page.extractionState}).`,
  ];
  const available = result.availableTypes
    .filter((entry) => entry.ok)
    .map((entry) => entry.type);
  lines.push(
    available.length > 0
      ? `Generatable types: ${available.join(", ")}.`
      : "No schema type can be generated from this page's evidence.",
  );

  if (!result.requestedType) return lines.join("\n");
  if (!result.proposal) {
    lines.push(
      `Cannot generate ${result.requestedType}: ${result.reasons.join("; ")}.`,
    );
    return lines.join("\n");
  }

  const validation = result.validation;
  const richResult = !validation
    ? "unchecked"
    : validation.richResultEligible === null
      ? "not applicable"
      : validation.richResultEligible
        ? "eligible"
        : `not eligible (missing ${validation.missingRichResultRequired.join(", ")})`;
  lines.push(
    `Proposed ${result.requestedType}: structurally ${validation?.valid ? "valid" : "invalid"}; rich results ${richResult}.`,
  );
  if (result.diff) {
    const count = (status: string) =>
      result.diff?.entries.filter((entry) => entry.status === status).length ??
      0;
    lines.push(
      `Diff vs existing markup: ${count("kept")} kept, ${count("changed")} changed, ${count("conflicting")} conflicting, ${count("added")} added, ${count("existing_only")} existing-only. Full JSON-LD is in structuredContent.proposal.`,
    );
  }
  return lines.join("\n");
}

export const getPageSchemaTool = {
  name: "get_page_schema",
  config: {
    title: "Get generated schema for a page",
    description:
      "Propose JSON-LD structured data for one audited page from the evidence the crawl already persisted, validate it (structural + Google rich-result eligibility), and diff it against the page's existing markup. Read-only: nothing is written and no page is fetched. Omit type to list generatable types.",
    inputSchema: getPageSchemaInputSchema,
    outputSchema: z
      .object({
        page: looseObjectOutputSchema,
        availableTypes: z.array(looseObjectOutputSchema),
        requestedType: z.string().nullable(),
        proposal: looseObjectOutputSchema.nullable(),
        validation: looseObjectOutputSchema.nullable(),
        diff: looseObjectOutputSchema.nullable(),
        reasons: z.array(z.string()),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetPageSchemaArgs, context) => {
    const audit = await resolveAudit(args.projectId, args.auditId);
    const result = await SchemaService.getPageSchema({
      projectId: args.projectId,
      auditId: audit.id,
      pageId: args.pageId,
      type: args.type,
    });
    if (!result) {
      throw new AppError(
        "NOT_FOUND",
        `Page ${args.pageId} not found in audit ${audit.id}.`,
      );
    }

    return mcpResponse({
      text: renderPageSchema(result),
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, audit.id),
      ),
      structuredContent: { ...result },
    });
  }),
};

// Spec 016 overflow: registered here so mcp/server.ts stays under max-lines;
// the registration is still one explicit call with concrete schema types.
export function registerGetPageSchemaTool(server: McpServer) {
  server.registerTool(
    getPageSchemaTool.name,
    getPageSchemaTool.config,
    instrumentMcpToolHandler(
      getPageSchemaTool.name,
      getPageSchemaTool.config.outputSchema,
      getPageSchemaTool.handler,
    ),
  );
}
