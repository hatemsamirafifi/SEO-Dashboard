import type { ToolExtra } from "@/server/mcp/context";
import {
  MCP_AUTH_CONTEXT_PROP,
  type McpToolAuthContext,
} from "@/server/mcp/context";

export interface ToolContext extends ToolExtra {
  auth: McpToolAuthContext;
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
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
    authInfo: {
      token: "token",
      clientId: auth.clientId ?? "client_123",
      scopes: [...auth.scopes],
      resource: new URL(auth.baseUrl),
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
