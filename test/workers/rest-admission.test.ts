// REST and MCP share the existing 4 MiB raw-byte admission limit. Exercise the
// real Worker/auth/REST boundary; the client is a harmless downstream stand-in
// so rejected input cannot silently parse or dispatch work before a late 413.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createKagiClient, search, summarize } = vi.hoisted(() => ({
  createKagiClient: vi.fn(),
  search: vi.fn(),
  summarize: vi.fn(),
}));
vi.mock("../../src/kagi/client.js", () => ({ createKagiClient }));

const { default: worker } = await import("../../src/index");

const TOKEN = "rest-admission-admin-fixture";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const PADDING = new TextEncoder().encode(" ".repeat(CHUNK_BYTES));
const ROUTES = [
  { path: "/search", payload: { queries: ["byte admission fixture"], max_age_s: 0 } },
  { path: "/summarize", payload: { url: "https://source.example/admission", max_age_s: 0 } },
];
const upstream = vi.fn(() => {
  throw new Error("REST admission fixtures must not contact an upstream");
});

/** Complete valid JSON plus a finite whitespace tail, with no eager prefetch. */
function trackedBody(payload: unknown, totalBytes?: number) {
  const prefix = new TextEncoder().encode(JSON.stringify(payload));
  const size = totalBytes ?? prefix.byteLength;
  const state = { pulls: 0, bytes: 0, closed: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (state.bytes === size) {
        state.closed = true;
        controller.close();
        return;
      }
      const chunk = state.bytes === 0
        ? prefix
        : PADDING.subarray(0, Math.min(CHUNK_BYTES, size - state.bytes));
      state.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state, size };
}

async function post(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body,
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

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue({
    query: "byte admission fixture",
    results: [],
    meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 },
  });
  summarize.mockResolvedValue({
    source: { kind: "url", ref: "https://source.example/admission" },
    summary: "Local admission fixture",
    engine_used: "scrape-default",
    target_language: "EN",
    meta: { impl: "scrape", cache_hit: false, elapsed_ms: 1 },
  });
  createKagiClient.mockReturnValue({ mode: "scrape", search, summarize });
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(ROUTES)("POST $path byte admission", ({ path, payload }) => {
  it("rejects an oversized declaration before body parsing or downstream work", async () => {
    const probe = trackedBody(payload);
    const parser = vi.spyOn(Request.prototype, "json");
    const res = await post(path, probe.body, { "Content-Length": String(MAX_BODY_BYTES + 1) });
    const wire = await res.json();

    expect.soft(res.status).toBe(413);
    expect.soft(wire).toEqual({ error: { code: "payload-too-large", message: expect.stringMatching(/\S/) } });
    expect.soft(probe.state.pulls).toBe(0);
    expect.soft(probe.state.bytes).toBe(0);
    expect.soft(probe.state.closed).toBe(false);
    expect.soft(probe.state.cancelled).toBe(true);
    expect.soft(parser.mock.calls.length).toBe(0);
    expect.soft(createKagiClient.mock.calls.length).toBe(0);
    expect.soft(search.mock.calls.length).toBe(0);
    expect.soft(summarize.mock.calls.length).toBe(0);
    expect.soft(upstream.mock.calls.length).toBe(0);
  });

  it.each([
    { label: "absent", contentLength: undefined },
    { label: "understated", contentLength: "1" },
  ])("bounds reading and cancels with $label Content-Length before parsing or dispatch", async ({ contentLength }) => {
    const probe = trackedBody(payload, MAX_BODY_BYTES + 2 * CHUNK_BYTES);
    const parser = vi.spyOn(Request.prototype, "json");
    const res = await post(path, probe.body, contentLength === undefined ? {} : { "Content-Length": contentLength });
    const wire = await res.json();

    expect.soft(res.status).toBe(413);
    expect.soft(wire).toEqual({ error: { code: "payload-too-large", message: expect.stringMatching(/\S/) } });
    expect.soft(probe.state.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES + CHUNK_BYTES);
    expect.soft(probe.state.closed).toBe(false);
    expect.soft(probe.state.cancelled).toBe(true);
    expect.soft(parser.mock.calls.length).toBe(0);
    expect.soft(createKagiClient.mock.calls.length).toBe(0);
    expect.soft(search.mock.calls.length).toBe(0);
    expect.soft(summarize.mock.calls.length).toBe(0);
    expect.soft(upstream.mock.calls.length).toBe(0);
  });

  it("caps UTF-8 bytes even when the decoded string would fit", async () => {
    // One astral character takes four UTF-8 bytes but two UTF-16 code units:
    // this valid body is MAX+1 bytes, yet its decoded length is only MAX-1.
    const unicodePayload = path === "/search"
      ? { queries: ["🧪"] }
      : { url: "https://source.example/🧪" };
    const probe = trackedBody(unicodePayload, MAX_BODY_BYTES + 1);
    const parser = vi.spyOn(Request.prototype, "json");
    const res = await post(path, probe.body);

    expect.soft(res.status).toBe(413);
    expect.soft(await res.json()).toEqual({ error: { code: "payload-too-large", message: expect.stringMatching(/\S/) } });
    expect.soft(probe.state.bytes).toBe(MAX_BODY_BYTES + 1);
    expect.soft(probe.state.closed).toBe(false);
    expect.soft(probe.state.cancelled).toBe(true);
    expect.soft(parser.mock.calls.length).toBe(0);
    expect.soft(createKagiClient.mock.calls.length).toBe(0);
    expect.soft(search.mock.calls.length).toBe(0);
    expect.soft(summarize.mock.calls.length).toBe(0);
    expect.soft(upstream.mock.calls.length).toBe(0);
  });

  it.each([
    { label: "a small valid body", bytes: undefined },
    { label: "valid JSON at exactly the 4 MiB cap", bytes: MAX_BODY_BYTES },
  ])("still dispatches $label", async ({ bytes }) => {
    const probe = trackedBody(payload, bytes);
    const res = await post(path, probe.body);
    const wire = await res.json();

    expect(res.status).toBe(200);
    expect(probe.state.bytes).toBe(probe.size);
    expect(createKagiClient).toHaveBeenCalledOnce();
    if (path === "/search") {
      expect(wire).toMatchObject({ results: [{ query: "byte admission fixture", ok: true }] });
      expect(search).toHaveBeenCalledOnce();
      expect(summarize).not.toHaveBeenCalled();
    } else {
      expect(wire).toMatchObject({ ok: true, data: { summary: "Local admission fixture" } });
      expect(summarize).toHaveBeenCalledOnce();
      expect(search).not.toHaveBeenCalled();
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
