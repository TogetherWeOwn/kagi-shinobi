// src/mcp/serve.ts hands the request's ExecutionContext to the per-request
// server. The result cache's background writes ride waitUntil (ADR 0017); on
// the stateless route (ADR 0020) the only context that outlives the response
// is the worker request's, so that is the one the Kagi client must receive.
//
// Runs in workerd: agents/mcp reaches cloudflare:workers.

import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const { createKagiClient } = vi.hoisted(() => ({ createKagiClient: vi.fn() }));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient }));

const { serveMcp } = await import("../../src/mcp/serve");

it("builds the Kagi client with the request's waitUntil", async () => {
  createKagiClient.mockReturnValue({ mode: "scrape" });
  const waitUntil = vi.fn();
  const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const request = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  const res = await serveMcp(request, env, ctx);
  await res.text();
  const opts = createKagiClient.mock.calls.at(-1)![1] as { waitUntil: (p: Promise<unknown>) => void };
  const work = Promise.resolve();
  opts.waitUntil(work);

  expect(res.status).toBe(200);
  expect(waitUntil).toHaveBeenCalledWith(work);
});
