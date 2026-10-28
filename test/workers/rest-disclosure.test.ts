// Successful REST batches must not turn a failed primary's private diagnostics
// into public metadata. Exercise the real bearer gate, client, and cache; only
// the upstream network is stubbed. Runs in workerd because the entry imports DOs.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { SearchResponse } from "../../src/kagi/types";
import { clearMemoryCache } from "../../src/token/store.js";

const CLIENT_KEY = "disclosure-client-fixture";
const DIAGNOSTIC = "private-primary-diagnostic: fixture-session-only";
const RESULT_URL = "https://source.example/result";

interface SearchBatch {
  results: Array<{ query: string; ok: boolean; data: SearchResponse }>;
}

async function testEnv() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLIENT_KEY));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    ...env,
    ADMIN_TOKEN: "disclosure-admin-fixture",
    CLIENT_KEYS: JSON.stringify({ "ck-disclosure": hash }),
    CLIENT_KEY_RPM: "0",
    CLIENT_KEY_RPD: "0",
    PER_BEARER_RPM: "0",
    KAGI_MODE: "scrape",
    KAGI_SESSION_TOKEN: "disclosure-session-fixture",
    AUTO_REFRESH_ENABLED: "false",
    MAX_API_CENTS_PER_MONTH: "0",
    KAGI_CALLS_PER_SECOND: "0",
    KAGI_CALLS_PER_DAY: "0",
    KAGI_CALLS_PER_MONTH: "0",
    SEARXNG_BASE_URL: "https://searxng.test",
  } as typeof env;
}

async function search(q: string): Promise<Response> {
  const request = new Request("https://worker.test/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLIENT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ queries: [q], engine: "auto", limit: 1 }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, await testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  clearMemoryCache();
  await env.TOKEN_KV.delete(env.TOKEN_KV_KEY);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  clearMemoryCache();
  await env.TOKEN_KV.delete(env.TOKEN_KV_KEY);
});

describe("authenticated POST /search disclosure boundary", () => {
  it("retains a successful auto fallback without exposing the failed primary's diagnostic", async () => {
    const q = `fallback disclosure ${crypto.randomUUID()}`;
    const upstreams: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      upstreams.push(url.origin);
      if (url.origin === "https://kagi.com" && url.pathname === "/html/search") {
        return new Response("private upstream body", { status: 503, statusText: DIAGNOSTIC });
      }
      if (url.origin === "https://searxng.test" && url.pathname === "/search") {
        return Response.json({
          query: q,
          number_of_results: 1,
          results: [{
            url: RESULT_URL,
            title: "Fallback result",
            content: "Fallback snippet",
            engine: "fixture-engine",
          }],
          answers: [],
          suggestions: [],
        });
      }
      throw new Error(`Unexpected upstream: ${url.origin}${url.pathname}`);
    });

    const res = await search(q);
    const text = await res.text();
    const body = JSON.parse(text) as SearchBatch;

    expect(res.status).toBe(200);
    expect(upstreams).toEqual(["https://kagi.com", "https://searxng.test"]);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      query: q,
      ok: true,
      data: {
        query: q,
        results: [{ url: RESULT_URL, title: "Fallback result", snippet: "Fallback snippet", source_impl: "searxng" }],
        meta: { impl: "searxng", cache_hit: false },
      },
    });
    const warnings = body.results[0].data.meta.warnings;
    expect(warnings?.join(" ")).toMatch(/fallback|falling back/i);
    expect.soft(warnings?.join(" ")).not.toContain(DIAGNOSTIC);
    expect.soft(text).not.toContain(DIAGNOSTIC);
  });

  it("preserves successful results and cache metadata on a repeat authenticated request", async () => {
    const q = `cached disclosure ${crypto.randomUUID()}`;
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://kagi.com" || url.pathname !== "/html/search") {
        throw new Error(`Unexpected upstream: ${url.origin}${url.pathname}`);
      }
      upstreamCalls += 1;
      return new Response(`<!doctype html><html><body>
        <div class="search-result">
          <div class="__sri-title"><a class="__sri_title_link" href="${RESULT_URL}">Cached result</a></div>
          <div class="__sri-desc">Cached snippet</div>
        </div>
      </body></html>`, { headers: { "Content-Type": "text/html" } });
    });

    const first = await search(q);
    const fresh = await first.json() as SearchBatch;
    const second = await search(q);
    const cached = await second.json() as SearchBatch;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fresh.results[0].data.meta.cache_hit).toBe(false);
    expect(cached.results[0]).toMatchObject({
      query: q,
      ok: true,
      data: {
        query: q,
        results: [{ url: RESULT_URL, title: "Cached result", snippet: "Cached snippet" }],
        meta: { impl: "scrape", cache_hit: true },
      },
    });
    expect(cached.results[0].data.meta.cache_age_s).toBeGreaterThanOrEqual(0);
    expect(upstreamCalls).toBe(1);
  });
});
