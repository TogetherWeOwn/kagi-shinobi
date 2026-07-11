// Worker entry: routes requests to REST, MCP, or admin handlers.
// Every non-/health path requires the ADMIN_TOKEN bearer.

import type { Env } from "./env.js";
import { requireBearer } from "./util/auth.js";
import { jsonError } from "./util/errors.js";
import { handleSearch, handleSummarize } from "./rest.js";
import { handleAdminRefresh, handleAdminToken, handleHealth } from "./token/admin.js";
import { KagiMcpAgent } from "./mcp.js";

export { KagiMcpAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET") {
      return handleHealth(request, env);
    }

    const authFailure = requireBearer(request, env);
    if (authFailure) return authFailure;

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      // McpAgent.serve() handles both the SSE and Streamable HTTP wire
      // protocols; McpAgent.serveSSE is the SSE-only variant. Prefer serve().
      return KagiMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    if (path === "/search" && method === "POST") {
      return handleSearch(request, env);
    }
    if (path === "/summarize" && method === "POST") {
      return handleSummarize(request, env);
    }
    if (path === "/admin/token" && method === "POST") {
      return handleAdminToken(request, env);
    }
    if (path === "/admin/refresh" && method === "POST") {
      return handleAdminRefresh(request, env);
    }

    return jsonError(404, "not-found", `${method} ${path} not routed`);
  },
} satisfies ExportedHandler<Env>;
