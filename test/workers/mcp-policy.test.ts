// Array rejection must happen before Agents scans initialization messages or
// dispatches tools, not merely before the SDK eventually rejects a large batch.
// Keep the real Worker, server and transport; observe entry through a pass-through
// boundary spy, and replace only the downstream client work with local fixtures.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createKagiClient, search, agentsEntered } = vi.hoisted(() => ({
  createKagiClient: vi.fn(),
  search: vi.fn(),
  agentsEntered: vi.fn(),
}));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient }));
vi.mock("agents/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("agents/mcp")>();
  return {
    ...actual,
    createLegacyMcpHandler: (...args: Parameters<typeof actual.createLegacyMcpHandler>) => {
      const handler = actual.createLegacyMcpHandler(...args);
      return (...requestArgs: Parameters<typeof handler>) => {
        agentsEntered();
        return handler(...requestArgs);
      };
    },
  };
});

const { default: worker } = await import("../../src/index");

const TOKEN = "mcp-policy-admin-fixture";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "admission-policy-test", version: "0" },
  },
};
const NOTIFICATION = { jsonrpc: "2.0", method: "notifications/initialized" };
const upstream = vi.fn(() => {
  throw new Error("MCP policy fixtures must not contact an upstream");
});

function toolCall(id: number, q: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "kagi_search_fetch", arguments: { queries: [q], max_age_s: 0 } },
  };
}

async function post(
  body: unknown,
  { path = "/mcp", headers = {} }: { path?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: body instanceof ReadableStream ? body : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, {
    ...env,
    ADMIN_TOKEN: TOKEN,
    PER_BEARER_RPM: "0",
    MAX_API_CENTS_PER_MONTH: "0",
  }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Preserve the top-level JSON shape; tolerate SSE only to diagnose the unfixed head. */
async function responseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("application/json")) return JSON.parse(text);
  return text.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as unknown);
}

/** A pull stays unfinished until the test releases it, avoiding timeout-based assertions. */
function heldBody() {
  let notifyPull: () => void = () => {};
  let finish: () => void = () => {};
  const pulled = new Promise<void>((resolve) => { notifyPull = resolve; });
  const state = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const pending = new Promise<void>((resolve) => {
        finish = () => { controller.close(); resolve(); };
      });
      notifyPull();
      return pending;
    },
  }, { highWaterMark: 0 });
  return { body, state, pulled, finish: () => finish() };
}

beforeEach(() => {
  vi.clearAllMocks();
  search.mockImplementation(async ({ q }: { q: string }) => ({
    query: q,
    results: [{
      rank: 1,
      url: "https://source.example/policy",
      title: "Local policy fixture",
      snippet: "Harmless stubbed work",
      source_domain: "source.example",
      source_impl: "scrape",
    }],
    meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 },
  }));
  createKagiClient.mockReturnValue({ mode: "scrape", search });
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /mcp rejects every JSON-RPC array before Agents entry", () => {
  it.each([
    { label: "an empty array", payload: [] },
    { label: "a one-item tool array", payload: [toolCall(2, "one local query")] },
    { label: "multiple harmless tool calls", payload: [toolCall(2, "first local query"), toolCall(3, "second local query")] },
    // SDK 1.32.1 caps batches at 100, but Agents scans for initialize first.
    // Put initialize last in this small 101-item fixture to protect that ordering.
    { label: "101 messages with initialize last", payload: [...Array.from({ length: 100 }, () => NOTIFICATION), INITIALIZE] },
  ])("rejects $label without wrapper scanning, tool dispatch or upstream work", async ({ payload }) => {
    const res = await post(payload);
    const body = await responseBody(res);

    expect.soft(res.status).toBe(400);
    expect.soft(res.headers.get("content-type") ?? "").toContain("application/json");
    // Standard JSON-RPC display text is fixed, independent of contents/count.
    expect.soft(body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect.soft(agentsEntered.mock.calls.length).toBe(0);
    expect.soft(search.mock.calls.length).toBe(0);
    expect.soft(upstream.mock.calls.length).toBe(0);
  });

  it("still serves a single initialize object through the real wrapper", async () => {
    const res = await post(INITIALIZE);
    const wire = await responseBody(res);
    const message = Array.isArray(wire) ? wire[0] : wire;

    expect(res.status).toBe(200);
    expect(message).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "kagi-shinobi" } } });
    expect(agentsEntered.mock.calls.length).toBe(1);
    expect(search.mock.calls.length).toBe(0);
    expect(upstream.mock.calls.length).toBe(0);
  });

  it("still accepts a single notification object", async () => {
    const res = await post(NOTIFICATION);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(agentsEntered.mock.calls.length).toBe(1);
    expect(search.mock.calls.length).toBe(0);
    expect(upstream.mock.calls.length).toBe(0);
  });

  it("still dispatches a single tool-call object exactly once", async () => {
    const res = await post(toolCall(2, "one permitted local query"));
    const wire = await responseBody(res);
    const message = (Array.isArray(wire) ? wire[0] : wire) as { error?: unknown; result: { isError?: boolean } };

    expect(res.status).toBe(200);
    expect(message.error).toBeUndefined();
    expect(message.result.isError).not.toBe(true);
    expect(agentsEntered.mock.calls.length).toBe(1);
    expect(search.mock.calls.length).toBe(1);
    expect(search.mock.calls[0][0]).toMatchObject({ q: "one permitted local query" });
    expect(upstream.mock.calls.length).toBe(0);
  });
});

describe("unknown MCP subpaths reject before body admission", () => {
  it.each([
    { label: "no declared size", contentLength: undefined },
    { label: "an oversized declaration", contentLength: String(MAX_BODY_BYTES + 1) },
  ])("returns authenticated 404 with $label without waiting for an unfinished body", async ({ contentLength }) => {
    const probe = heldBody();
    const pending = post(probe.body, {
      path: "/mcp/anything",
      headers: contentLength === undefined ? {} : { "Content-Length": contentLength },
    });
    const first = await Promise.race([
      pending.then(() => "response"),
      probe.pulled.then(() => "body-pull"),
    ]);
    // Release any incorrectly-started read and join it even when the test fails.
    probe.finish();
    const res = await pending;
    await res.body?.cancel();

    expect.soft(first).toBe("response");
    expect.soft(res.status).toBe(404);
    expect.soft(probe.state.pulls).toBe(0);
    expect.soft(search.mock.calls.length).toBe(0);
    expect.soft(upstream.mock.calls.length).toBe(0);
  });

  it("keeps the bearer gate in front of a nested POST with an oversized declaration", async () => {
    const probe = heldBody();
    const pending = post(probe.body, {
      path: "/mcp/anything",
      headers: { Authorization: "", "Content-Length": String(MAX_BODY_BYTES + 1) },
    });
    const first = await Promise.race([pending.then(() => "response"), probe.pulled.then(() => "body-pull")]);
    probe.finish();
    const res = await pending;
    await res.body?.cancel();

    expect(first).toBe("response");
    expect(res.status).toBe(401);
    expect(probe.state.pulls).toBe(0);
    expect(agentsEntered.mock.calls.length).toBe(0);
    expect(search.mock.calls.length).toBe(0);
    expect(upstream.mock.calls.length).toBe(0);
  });
});

describe("MCP rejected-read error envelope", () => {
  it("redacts a rejected body read as the exact parse-error response before downstream work", async () => {
    const diagnostic = "private read diagnostic: fixture-only";
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reads += 1;
        return Promise.reject(new Error(diagnostic));
      },
    }, { highWaterMark: 0 });

    const res = await post(body);
    const wire = await responseBody(res);

    expect(res.status).toBe(400);
    expect(wire).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: Invalid JSON" },
    });
    expect(JSON.stringify(wire)).not.toContain(diagnostic);
    expect(reads).toBe(1);
    expect(agentsEntered.mock.calls.length).toBe(0);
    expect(search.mock.calls.length).toBe(0);
    expect(upstream.mock.calls.length).toBe(0);
  });
});
