// /mcp is served statelessly: one McpServer per request, no Durable Object.
//
// ADR 0020. Before it, every MCP session created a KagiMcpAgent Durable Object
// (McpAgent.serve) that persisted its transport state and SSE event log and
// was never cleaned up — 25,967 stored objects for 627 active ones. Nothing in
// the tool surface reads per-session state: tools are request/response, the
// budget and rate counters live in the Meter DO, cached results in
// ResultCache, research runs in the ResearchRun singleton.
//
// These tests drive the real worker entry (src/index.ts) with raw JSON-RPC over
// Streamable HTTP, so the bearer gate and the rate limit stay in front of the
// MCP surface exactly as before. MCP_OBJECT is replaced with a namespace that
// throws on any use: if /mcp ever routes to a session DO again, every case
// here fails.
//
// Runs in workerd: src/index.ts reaches cloudflare:workers.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const TOKEN = "stateless-admin-token";
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Any touch of the session DO namespace is a test failure. */
const doTrap = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`MCP_OBJECT.${String(prop)} used — /mcp must not create a session Durable Object`);
    },
  },
);

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    ADMIN_TOKEN: TOKEN,
    PER_BEARER_RPM: "0",
    MCP_OBJECT: doTrap,
    ...overrides,
  } as typeof env;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const STREAMABLE_ACCEPT = "application/json, text/event-stream";

async function post(
  body: unknown,
  { headers = {}, overrides = {} }: { headers?: Record<string, string>; overrides?: Record<string, unknown> } = {},
): Promise<Response> {
  const request = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      Accept: STREAMABLE_ACCEPT,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Read every JSON-RPC message out of an SSE or JSON response body. */
async function messages(res: Response): Promise<JsonRpcResponse[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as JsonRpcResponse);
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: Parameters<typeof post>[1] = {},
): Promise<{ res: Response; message: JsonRpcResponse }> {
  const res = await post({ jsonrpc: "2.0", id: 1, method, params }, opts);
  const all = await messages(res);
  const message = all.find((m) => m.id === 1);
  if (!message) throw new Error(`no response to ${method}; status ${res.status}`);
  return { res, message };
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "stateless-test", version: "0" },
};

// The tool set wrangler.jsonc's KAGI_MODE="scrape" allows; owned by
// test/e2e/smoke.spec.ts and mcp-tools.test.ts. Repeated here only to prove a
// sessionless tools/list returns the same contract.
const SCRAPE_MODE_TOOLS = [
  "kagi_fastgpt",
  "kagi_personalized_rank",
  "kagi_research_cancel_run",
  "kagi_research_create_run",
  "kagi_research_get_output",
  "kagi_research_wait_for_run",
  "kagi_search_fetch",
  "kagi_small_web",
  "kagi_summarize_url",
  "kagi_summarizer",
];

function toolNames(message: JsonRpcResponse): string[] {
  const tools = (message.result?.tools ?? []) as Array<{ name: string }>;
  return tools.map((t) => t.name).sort();
}

describe("/mcp serves without a per-session Durable Object", () => {
  it("answers initialize and issues no session id", async () => {
    const { res, message } = await rpc("initialize", INITIALIZE_PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((message.result?.serverInfo as { name: string }).name).toBe("kagi-shinobi");
  });

  it("answers tools/list on its own, with no prior initialize and no session header", async () => {
    const { res, message } = await rpc("tools/list");

    expect(res.status).toBe(200);
    expect(message.error).toBeUndefined();
    expect(toolNames(message)).toEqual(SCRAPE_MODE_TOOLS);
  });

  it("ignores a session id left over from a pre-stateless session", async () => {
    // Clients connected before ADR 0020 still hold an Mcp-Session-Id and keep
    // sending it. A stateless server must serve them rather than 404 them.
    const { res, message } = await rpc("tools/list", {}, {
      headers: { "Mcp-Session-Id": "streamable-http:0123456789abcdef" },
    });

    expect(res.status).toBe(200);
    expect(toolNames(message)).toEqual(SCRAPE_MODE_TOOLS);
  });

  it("runs a tool call end to end and returns the ADR 0010 envelope", async () => {
    // kagi_summarize_url rejects an unsupported language before the Kagi
    // client is invoked, so this reaches no upstream.
    const { message } = await rpc("tools/call", {
      name: "kagi_summarize_url",
      arguments: { url: "https://example.test/a", target_language: "xx" },
    });

    const result = message.result as {
      isError: boolean;
      structuredContent: { error_kind: string };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error_kind).toBe("invalid_language");
    expect(result.content[0]?.type).toBe("text");
  });

  it("gives concurrent requests isolated servers", async () => {
    // One shared McpServer cannot connect to two transports at once; a
    // per-request factory is what makes parallel calls safe.
    const results = await Promise.all([rpc("tools/list"), rpc("tools/list"), rpc("prompts/list")]);

    for (const { res, message } of results) {
      expect(res.status).toBe(200);
      expect(message.error).toBeUndefined();
    }
  });

  it("answers GET /mcp with 405: there is no server-to-client stream to hold open", async () => {
    // Spec: a server that offers no standalone SSE stream answers GET with 405.
    // Without this a GET would park an idle SSE response nothing ever writes to.
    const request = new Request("https://worker.test/mcp", {
      method: "GET",
      headers: { ...auth, Accept: "text/event-stream" },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });
});

describe("the gate in front of /mcp is unchanged", () => {
  it("rejects a POST with no bearer", async () => {
    const request = new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: STREAMABLE_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(401);
  });

  it("serves a scoped client key (ADR 0013)", async () => {
    const key = "stateless-client-key";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const { res, message } = await rpc("tools/list", {}, {
      headers: { Authorization: `Bearer ${key}` },
      overrides: { CLIENT_KEYS: JSON.stringify({ "ck-stateless": hex }) },
    });

    expect(res.status).toBe(200);
    expect(toolNames(message)).toEqual(SCRAPE_MODE_TOOLS);
  });

  it("still applies the per-bearer rate limit", async () => {
    const token = "stateless-rl-token";
    const opts = {
      headers: { Authorization: `Bearer ${token}` },
      overrides: { ADMIN_TOKEN: token, PER_BEARER_RPM: "1" },
    };
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    const first = await post(body, opts);
    await first.text();
    const second = await post(body, opts);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
