// The SDK's 4 MiB reader cannot protect /mcp if Agents parses a clone first.
// Prove admission at the real Worker boundary by observing bounded pulls and
// cancellation, not just an eventual 413 after the body was already drained.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

const TOKEN = "mcp-admission-admin-fixture";
// SDK 1.32.1's existing default, not a new deployment setting.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const INITIALIZE = new TextEncoder().encode(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "body-admission-test", version: "0" },
  },
}));
const PADDING = new TextEncoder().encode(" ".repeat(CHUNK_BYTES));

/** Valid initialize JSON plus whitespace, generated one bounded chunk at a time. */
function trackedBody(totalBytes = INITIALIZE.byteLength) {
  const state = { pulls: 0, bytes: 0, closed: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (state.bytes === totalBytes) {
        state.closed = true;
        controller.close();
        return;
      }
      const chunk = state.bytes === 0
        ? INITIALIZE
        : PADDING.subarray(0, Math.min(CHUNK_BYTES, totalBytes - state.bytes));
      state.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

async function post(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ADMIN_TOKEN: TOKEN, PER_BEARER_RPM: "0" }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function initializeMessage(res: Response): Promise<{
  jsonrpc: string;
  id: number;
  result?: { serverInfo: { name: string } };
  error?: unknown;
}> {
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("application/json")
    ? text
    : text.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length);
  if (!json) throw new Error(`No initialize response; status ${res.status}`);
  return JSON.parse(json);
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("MCP admission must not contact an upstream");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /mcp body admission before Agents parsing", () => {
  it("rejects a declared over-limit length without pulling the body and cancels it", async () => {
    // The actual body is small and valid: rejection must use the declaration,
    // before a clone/json parser can drain even this harmless local fixture.
    const probe = trackedBody();
    const res = await post(probe.body, { "Content-Length": String(MAX_BODY_BYTES + 1) });
    await res.body?.cancel();

    expect.soft(res.status).toBe(413);
    expect.soft(probe.state.pulls).toBe(0);
    expect.soft(probe.state.bytes).toBe(0);
    expect.soft(probe.state.closed).toBe(false);
    expect.soft(probe.state.cancelled).toBe(true);
  });

  it.each([
    { label: "absent", contentLength: undefined },
    { label: "understated", contentLength: "1" },
  ])("bounds reading and cancels with $label Content-Length", async ({ contentLength }) => {
    // Two extra chunks provide a bounded tail which a reader must not drain.
    // The prefix is valid JSON; an unbounded json() has to read its whitespace
    // suffix to EOF, so neither an eventual 413 nor a parse error can pass this.
    const probe = trackedBody(MAX_BODY_BYTES + 2 * CHUNK_BYTES);
    const res = await post(probe.body, contentLength === undefined ? {} : { "Content-Length": contentLength });
    await res.body?.cancel();

    expect.soft(res.status).toBe(413);
    expect.soft(probe.state.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES + CHUNK_BYTES);
    expect.soft(probe.state.closed).toBe(false);
    expect.soft(probe.state.cancelled).toBe(true);
  });

  it.each([
    { label: "a small valid request", bytes: INITIALIZE.byteLength },
    { label: "a valid request at exactly the 4 MiB cap", bytes: MAX_BODY_BYTES },
  ])("still serves $label", async ({ bytes }) => {
    const probe = trackedBody(bytes);
    const res = await post(probe.body);
    const message = await initializeMessage(res);

    expect(res.status).toBe(200);
    expect(message).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "kagi-shinobi" } },
    });
    expect(message.error).toBeUndefined();
    expect(probe.state.bytes).toBe(bytes);
  });
});
