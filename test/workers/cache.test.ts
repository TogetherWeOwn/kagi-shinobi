// Read-through cache over the Workers Cache API.
//
// Runs in workerd because `caches.default` has no Node equivalent — that is
// the whole reason this file sat at 0% coverage before the runtime split.

import { describe, expect, it, vi } from "vitest";
import { cacheKey, readCache, writeCache, type CacheDomain } from "../../src/kagi/cache";

/** Collects waitUntil promises so a test can await the write it triggered. */
function collectingCtx() {
  const pending: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    settled: () => Promise.all(pending),
  };
}

/** Unique per test — the cache is shared process-wide within a workerd run. */
let seq = 0;
function uniquePayload(extra: Record<string, unknown> = {}) {
  seq += 1;
  return { q: `payload-${seq}`, ...extra };
}

describe("cacheKey", () => {
  it("is deterministic for the same domain, impl, and payload", async () => {
    const payload = { q: "kagi", limit: 10 };

    const a = await cacheKey("search", "scrape", payload);
    const b = await cacheKey("search", "scrape", payload);

    expect(a.url).toBe(b.url);
  });

  it("keys under the internal namespace with the domain and impl in the path", async () => {
    const key = await cacheKey("summarize", "api", { url: "https://example.test" });

    expect(key.url).toMatch(
      /^https:\/\/cache\.kagi-shinobi\.internal\/summarize\/api\/[0-9a-f]{64}$/,
    );
    expect(key.method).toBe("GET");
  });

  it("separates the two impls, so a scrape result never serves an api caller", async () => {
    const payload = { q: "kagi" };

    const scrape = await cacheKey("search", "scrape", payload);
    const api = await cacheKey("search", "api", payload);

    expect(scrape.url).not.toBe(api.url);
  });

  it("separates domains", async () => {
    const search = await cacheKey("search", "scrape", { x: 1 });
    const fastgpt = await cacheKey("fastgpt", "scrape", { x: 1 });

    expect(search.url).not.toBe(fastgpt.url);
  });

  it("separates differing payloads", async () => {
    const a = await cacheKey("search", "scrape", { q: "one" });
    const b = await cacheKey("search", "scrape", { q: "two" });

    expect(a.url).not.toBe(b.url);
  });

  it("treats undefined and null payloads as the same empty key", async () => {
    const undef = await cacheKey("lenses", "api", undefined);
    const nul = await cacheKey("lenses", "api", null);

    expect(undef.url).toBe(nul.url);
  });
});

describe("readCache", () => {
  it("returns null on a miss", async () => {
    const key = await cacheKey("search", "scrape", uniquePayload());

    expect(await readCache(key)).toBeNull();
  });

  it("returns the stored value on a hit", async () => {
    const key = await cacheKey("search", "scrape", uniquePayload());
    const { ctx, settled } = collectingCtx();
    const value = { query: "kagi", results: [{ title: "a result" }] };

    await writeCache(key, "search", value, ctx);
    await settled();

    expect(await readCache(key)).toEqual(value);
  });

  it("returns null when the cached body is not JSON", async () => {
    const key = await cacheKey("search", "scrape", uniquePayload());
    await caches.default.put(
      key,
      new Response("not json at all", {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      }),
    );

    expect(await readCache(key)).toBeNull();
  });
});

describe("writeCache", () => {
  it("never blocks the caller — the put goes through waitUntil", async () => {
    const key = await cacheKey("search", "scrape", uniquePayload());
    const waitUntil = vi.fn();

    await writeCache(key, "search", { any: "value" }, { waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  // The TTL table is the cost/freshness contract: a summary is stable for a
  // day, a search result is not.
  it.each<[CacheDomain, number]>([
    ["search", 300],
    ["summarize", 86_400],
    ["fastgpt", 900],
    ["extract", 3_600],
    ["enrich", 1_800],
    ["lenses", 3_600],
    ["smallweb", 600],
  ])("stores %s with a max-age of %i seconds", async (domain, ttl) => {
    const key = await cacheKey(domain, "api", uniquePayload({ domain }));
    const { ctx, settled } = collectingCtx();

    await writeCache(key, domain, { value: 1 }, ctx);
    await settled();

    const hit = await caches.default.match(key);
    expect(hit?.headers.get("Cache-Control")).toBe(`public, max-age=${ttl}`);
  });

  it("stores JSON so a later read parses it back unchanged", async () => {
    const key = await cacheKey("extract", "api", uniquePayload());
    const { ctx, settled } = collectingCtx();
    const value = { nested: { list: [1, 2, 3] }, flag: true, nothing: null };

    await writeCache(key, "extract", value, ctx);
    await settled();

    expect(await readCache(key)).toEqual(value);
  });
});
