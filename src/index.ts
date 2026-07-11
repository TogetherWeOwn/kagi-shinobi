// Worker entry: routes requests to REST, MCP, or admin handlers.
// Every non-/health path requires the ADMIN_TOKEN bearer.

import type { Env } from "./env.js";
import { requireBearer } from "./util/auth.js";
import { jsonError } from "./util/errors.js";
import { handleSearch, handleSummarize } from "./rest.js";
import { handleAdminRefresh, handleAdminToken, handleHealth } from "./token/admin.js";
import { KagiMcpAgent } from "./mcp.js";
import { landingResponse } from "./landing.js";
import { checkAndIncrement } from "./util/ratelimit.js";

export { KagiMcpAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Public routes — no bearer required. Landing page + health check are
    // safe to expose; everything else is gated below.
    if (path === "/" && method === "GET") {
      return landingResponse();
    }
    if (path === "/health" && method === "GET") {
      return handleHealth(request, env);
    }

    const authFailure = requireBearer(request, env);
    if (authFailure) return authFailure;

    // Per-bearer rate limit (PER_BEARER_RPM). Admin endpoints skip the limit
    // so operators can reset a runaway automation without eating quota.
    if (!path.startsWith("/admin/")) {
      const bearer = request.headers.get("Authorization")!.slice("Bearer ".length).trim();
      const rl = await checkAndIncrement(env, bearer);
      if (!rl.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              code: "rate-limited",
              message: `${rl.count}/${rl.limit_rpm} requests this minute`,
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(rl.retry_after_seconds ?? 60),
              "X-RateLimit-Limit": String(rl.limit_rpm),
              "X-RateLimit-Remaining": "0",
            },
          },
        );
      }
    }

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
