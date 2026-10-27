import {
  MCP_AUTH_CONTEXT_PROP,
  type McpToolAuthContext,
} from "@/server/mcp/context";

export interface ToolContext {
  auth: McpToolAuthContext;
  authInfo: {
    extra: Record<string, unknown>;
  };
}

export function makeToolContext(
  overrides: Partial<McpToolAuthContext> = {},
): ToolContext {
  const auth: McpToolAuthContext = {
    userId: "user_123",
    userEmail: "alice@example.com",
    organizationId: "org_123",
    role: "owner",
    clientId: "client_123",
    scopes: ["mcp"],
    audience: "https://open-seo.test",
    subject: "user_123",
    baseUrl: "https://open-seo.test",
    ...overrides,
  };

  return {
    auth,
    authInfo: {
      extra: {
        [MCP_AUTH_CONTEXT_PROP]: auth,
      },
    },
  };
}

export function textContent(result: {
  content?: Array<{ type: string; text?: string }>;
}) {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}
