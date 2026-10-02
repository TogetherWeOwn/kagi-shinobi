// ResultCache — the authoritative L2 of the read-through result cache.
//
// The Cache API does not operate on *.workers.dev, so the L1 fast path in
// cache.ts misses there on every query. This Durable Object (DO-SQLite) is
// the layer the correctness argument depends on: it answers everywhere,
// including workers.dev.
//
// Single-flight lives here, not in a module map like refresh.ts's `inflight`:
// that only coalesces within one isolate, while ten identical queries landing
// on different isolates would each miss and hit Kagi. `claim()` is synchronous
// end to end (like every Meter method — no `await` between read and write),
// so exactly one caller wins the key; losers poll `lookup()` until the
// winner stores. See docs/adr/0016-result-cache.md.
//
// A missing/broken binding fails open (the facade fetches direct) — the cache
// is an optimization and must never break serving.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** Cacheable domains. Search/summarize/fastgpt results are stable enough to
 *  reuse; extract/enrich are per-URL metadata chains for downstream
 *  composition, rank is account personalization that must stay live, and Small
 *  Web browse is a free RSS feed — caching them buys little and risks serving
 *  stale composed state. See ADR 0016. */
export type CacheDomain = "search" | "fastgpt" | "summarize";

/** TTLs per the card: search 24h, fastgpt 6h, summarize 7d. */
export const TTL_SECONDS: Record<CacheDomain, number> = {
  search: 24 * 60 * 60,
  fastgpt: 6 * 60 * 60,
  summarize: 7 * 24 * 60 * 60,
};

export interface CacheLookup {
  /** "hit" when a live entry exists, "miss" otherwise (absent or expired). */
  status: "hit" | "miss";
  /** The stored response JSON, only on hit. */
  body?: string;
  /** Seconds since the upstream fetch, only on hit. */
  age_s?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
  entries: number;
  hit_rate: number;
  by_domain: Record<CacheDomain, { hits: number; misses: number; stores: number }>;
}

export class ResultCache extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS entries (
          key TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          body TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS claims (
          key TEXT PRIMARY KEY,
          since INTEGER NOT NULL
        )`,
      );
      // Cumulative counters. Counters only move forward; purge deletes rows
      // from `entries`, never from here — see the snapshot test pinning that
      // hits+misses+stores survive a purge.
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (
          name TEXT PRIMARY KEY,
          n INTEGER NOT NULL
        )`,
      );
    });
  }

  /**
   * Read one entry. Expired rows are deleted lazily on read; entries older
   * than `maxAgeS` are treated as misses (but kept — another caller with a
   * looser bound may still use them). `maxAgeS=0` always misses: the facade
   * reserves that value for a forced refresh, but the DO treats any
   * non-positive bound as "no stored entry is fresh enough".
   */
  lookup(key: string, domain: CacheDomain, nowMs: number, maxAgeS?: number): CacheLookup {
    const rows = [
      ...this.ctx.storage.sql.exec("SELECT body, fetched_at FROM entries WHERE key = ?", key),
    ];
    if (rows.length === 0) {
      this.bump(domain, "misses");
      return { status: "miss" };
    }
    const body = String(rows[0].body);
    const fetchedAt = Number(rows[0].fetched_at);
    const ageS = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000));
    const ttl = TTL_SECONDS[domain];
    if (ageS >= ttl) {
      this.ctx.storage.sql.exec("DELETE FROM entries WHERE key = ?", key);
      this.bump(domain, "misses");
      return { status: "miss" };
    }
    if (maxAgeS !== undefined && ageS > maxAgeS) {
      this.bump(domain, "misses");
      return { status: "miss" };
    }
    this.bump(domain, "hits");
    return { status: "hit", body, age_s: ageS };
  }

  /**
   * Atomically claim the right to fetch `key`: true for exactly one caller,
   * false for every concurrent contender. Synchronous end to end — no `await`
   * between the read and the write — so the DO's single-threaded execution
   * makes the claim atomic. A `store()` for the key releases the claim.
   */
  claim(key: string, nowMs: number): boolean {
    const rows = [...this.ctx.storage.sql.exec("SELECT since FROM claims WHERE key = ?", key)];
    if (rows.length > 0) return false;
    this.ctx.storage.sql.exec("INSERT INTO claims (key, since) VALUES (?, ?)", key, nowMs);
    return true;
  }

  /**
   * Release a claim without storing (the fetch failed). The next contender
   * may claim immediately — no backoff here; the losers' poll loop already
   * spaces retries.
   */
  release(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE key = ?", key);
  }

  /** Store a fetched response and release the claim. Overwrites on re-fetch. */
  store(key: string, domain: CacheDomain, body: string, nowMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (key, domain, body, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET domain = excluded.domain, body = excluded.body, fetched_at = excluded.fetched_at`,
      key,
      domain,
      body,
      nowMs,
    );
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE key = ?", key);
    this.bump(domain, "stores");
  }

  /**
   * Delete every entry past its TTL. Runs hourly from the worker's
   * `scheduled()` handler; Kagi results stay transient — nothing survives
   * past its TTL. Returns the number of rows removed.
   */
  purge(nowMs: number): number {
    let removed = 0;
    for (const domain of Object.keys(TTL_SECONDS) as CacheDomain[]) {
      const cutoff = nowMs - TTL_SECONDS[domain] * 1000;
      const cursor = this.ctx.storage.sql.exec(
        "DELETE FROM entries WHERE domain = ? AND fetched_at <= ? RETURNING key",
        domain,
        cutoff,
      );
      removed += [...cursor].length;
    }
    // Claims are worker-local leases, not data: a crashed winner must not
    // hold the key past one purge interval.
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE since <= ?", nowMs - 3_600_000);
    return removed;
  }

  stats(): CacheStats {
    const rows = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM entries")];
    const entries = rows.length > 0 ? Number(rows[0].n) : 0;
    const total = (kind: "hits" | "misses" | "stores"): number => {
      const r = [
        ...this.ctx.storage.sql.exec("SELECT n FROM counters WHERE name = ?", `total:${kind}`),
      ];
      return r.length > 0 ? Number(r[0].n) : 0;
    };
    const hits = total("hits");
    const misses = total("misses");
    const stores = total("stores");
    const byDomain = {} as CacheStats["by_domain"];
    for (const domain of Object.keys(TTL_SECONDS) as CacheDomain[]) {
      byDomain[domain] = {
        hits: this.readCounter(`${domain}:hits`),
        misses: this.readCounter(`${domain}:misses`),
        stores: this.readCounter(`${domain}:stores`),
      };
    }
    return {
      hits,
      misses,
      stores,
      entries,
      hit_rate: hits + misses === 0 ? 0 : hits / (hits + misses),
      by_domain: byDomain,
    };
  }

  private bump(domain: CacheDomain, kind: "hits" | "misses" | "stores"): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (name, n) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET n = n + 1`,
      `${domain}:${kind}`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (name, n) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET n = n + 1`,
      `total:${kind}`,
    );
  }

  private readCounter(name: string): number {
    const rows = [...this.ctx.storage.sql.exec("SELECT n FROM counters WHERE name = ?", name)];
    if (rows.length === 0) return 0;
    const value = Number(rows[0].n);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
}

/** Domains the cache stores. Anything else bypasses it. */
export function isCacheDomain(domain: string): domain is CacheDomain {
  return (Object.keys(TTL_SECONDS) as string[]).includes(domain);
}
