// Read-through cache for Kagi calls. Uses the Workers Cache API keyed by a
// synthetic URL derived from tool + args + impl. Bearer identity is NOT part
// of the key — search/summarize results aren't user-scoped, so cross-bearer
// sharing is safe and cheap.
//
// TTLs are conservative: search 5m, summaries 24h, lens list 1h, enrich 30m,
// fastgpt 15m. Keep an eye on Kagi's `cache=true` behavior — for endpoints
// that already de-dup upstream (fastgpt, summarize) the local cache is a pure
// cost-saver; for search it's mostly a latency win.

export type CacheDomain =
  | "search"
  | "summarize"
  | "fastgpt"
  | "extract"
  | "enrich"
  | "lenses"
  | "smallweb";

const TTL_SECONDS: Record<CacheDomain, number> = {
  search: 5 * 60,
  summarize: 24 * 60 * 60,
  fastgpt: 15 * 60,
  extract: 60 * 60,
  enrich: 30 * 60,
  lenses: 60 * 60,
  smallweb: 10 * 60,
};

const NAMESPACE = "https://cache.kagi-shinobi.internal";

async function digestHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function cacheKey(
  domain: CacheDomain,
  impl: "scrape" | "api",
  payload: unknown,
): Promise<Request> {
  const body = JSON.stringify(payload ?? null);
  const hash = await digestHex(`${domain}|${impl}|${body}`);
  return new Request(`${NAMESPACE}/${domain}/${impl}/${hash}`, { method: "GET" });
}

export async function readCache<T>(key: Request): Promise<T | null> {
  const hit = await caches.default.match(key);
  if (!hit) return null;
  try {
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

export async function writeCache(
  key: Request,
  domain: CacheDomain,
  value: unknown,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
  const ttl = TTL_SECONDS[domain];
  const resp = new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  // Fire-and-forget — never block the caller on cache writes.
  ctx.waitUntil(caches.default.put(key, resp));
}
