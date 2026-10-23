import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
import type { PageSchemaResult } from "@/server/features/audit/services/SchemaService";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getAuditForProject: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getPageSchema: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getAuditForProject: mocks.getAuditForProject,
    getLatestAuditForProject: mocks.getLatestAuditForProject,
  },
}));
vi.mock("@/server/features/audit/services/SchemaService", () => ({
  SchemaService: { getPageSchema: mocks.getPageSchema },
}));

import { getPageSchemaTool } from "@/server/mcp/tools/get-page-schema";

const authContext = {
  userId: "user_123",
  userEmail: "alice@example.com",
  organizationId: "org_123",
  clientId: "client_123",
  scopes: ["mcp"],
  audience: "https://open-seo.test/mcp",
  subject: "user_123",
  baseUrl: "https://open-seo.test",
};

const toolExtra: ToolExtra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: {
    token: "token",
    clientId: "client_123",
    scopes: ["mcp"],
    resource: new URL("https://open-seo.test/mcp"),
    extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
  } satisfies AuthInfo,
};

const RESULT: PageSchemaResult = {
  page: {
    id: "page_1",
    url: "https://example.com/p/rug",
    pageType: "product",
    extractionState: "STATIC_COMPLETE",
  },
  availableTypes: [
    { type: "Product", ok: true, reasons: [] },
    {
      type: "Article",
      ok: false,
      reasons: ["No observed Article structured data on this page"],
    },
  ],
  requestedType: "Product",
  proposal: {
    type: "Product",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Berber Rug",
    },
    properties: [
      {
        path: "name",
        value: "Berber Rug",
        source: "salla-extraction.name",
      },
    ],
    notes: [],
  },
  validation: {
    valid: true,
    errors: [],
    richResultEligible: false,
    missingRichResultRequired: ["image", "offers.price"],
    missingRichResultRecommended: [],
  },
  diff: {
    entries: [
      {
        path: "name",
        status: "kept",
        existing: "Berber Rug",
        proposed: "Berber Rug",
        source: "salla-extraction.name",
      },
    ],
    notes: [],
  },
  reasons: [],
};

function textOf(result: CallToolResult): string {
  const first: unknown = result.content[0];
  if (typeof first !== "object" || first === null) return "";
  if (!("type" in first) || first.type !== "text") return "";
  if (!("text" in first) || typeof first.text !== "string") return "";
  return first.text;
}

describe("get_page_schema MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockReset();
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.getAuditForProject.mockReset();
    mocks.getLatestAuditForProject.mockReset();
    mocks.getLatestAuditForProject.mockResolvedValue({
      id: "audit_1",
      startUrl: "https://example.com",
    });
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit_1",
      startUrl: "https://example.com",
    });
    mocks.getPageSchema.mockReset();
  });

  it("lists generatable types when no type is requested", async () => {
    mocks.getPageSchema.mockResolvedValue({
      ...RESULT,
      requestedType: null,
      proposal: null,
      validation: null,
      diff: null,
    });

    const result = await getPageSchemaTool.handler(
      { projectId: "project_1", pageId: "page_1" },
      toolExtra,
    );

    expect(textOf(result)).toContain("Generatable types: Product.");
    expect(result.structuredContent?.requestedType).toBeNull();
  });

  it("renders validation and diff for a proposal", async () => {
    mocks.getPageSchema.mockResolvedValue(RESULT);

    const result = await getPageSchemaTool.handler(
      { projectId: "project_1", pageId: "page_1", type: "Product" },
      toolExtra,
    );

    const text = textOf(result);
    expect(text).toContain(
      "rich results not eligible (missing image, offers.price)",
    );
    expect(text).toContain("1 kept, 0 changed");
    expect(result.structuredContent?.proposal).toMatchObject({
      jsonLd: { "@type": "Product", name: "Berber Rug" },
    });
  });

  it("scopes the page to the resolved audit and project", async () => {
    mocks.getPageSchema.mockResolvedValue(RESULT);

    await getPageSchemaTool.handler(
      { projectId: "project_1", auditId: "audit_1", pageId: "page_1" },
      toolExtra,
    );

    expect(mocks.getPageSchema).toHaveBeenCalledWith({
      projectId: "project_1",
      auditId: "audit_1",
      pageId: "page_1",
      type: undefined,
    });
  });

  it("reports a page outside the audit as not found", async () => {
    mocks.getPageSchema.mockResolvedValue(null);

    await expect(
      getPageSchemaTool.handler(
        { projectId: "project_1", pageId: "page_1" },
        toolExtra,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
