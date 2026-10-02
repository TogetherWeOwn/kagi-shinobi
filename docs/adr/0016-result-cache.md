# ADR 0016 — Read-through result cache that works on workers.dev

**Status:** Accepted — 2026-10-02
**Relates to:** [ADR 0003](0003-canonical-response-shapes.md) (the `meta` contract
it extends), [ADR 0006](0006-serialize-rate-and-spend-counters.md) (the DO
serialization pattern it reuses), [ADR 0013](0013-scoped-client-keys-and-searxng-get-search.md)
(the Kagi call budget it preserves), [ADR 0014](0014-searxng-fallback-engine.md)
(the engine tier the key includes)

## Context

`src/kagi/cache.ts` was dead code: nothing in `src/` called it, and the Cache
API does not operate on `*.workers.dev`, so every agent query hit Kagi. The
owner verified on 2026-10-01 that the Cache API **does** work on the attached
custom domain (`shinobi.infextion.net`), and corrected the account tier: Workers
Paid + R2 Paid + Cache Reserve, not free tier. Quotas are not the constraint,
but new usage-based spend stays minimal and is noted in the PR.

## Decision

**Two layers: Cache API as best-effort L1, one `ResultCache` Durable Object
(DO-SQLite) as authoritative L2.**

- L1 is per-colo and free to read; it misses (or throws) on `workers.dev` and
  the code treats that as an ordinary miss. L2 answers everywhere, including
  `workers.dev`, and is the only layer the correctness argument depends on.
- Key: `sha256(domain|engine|normalized args)` — the card's formula, where
  "normalized args" is the full resolved arg object **including `impl`**
  (scrape vs api results differ in `source_impl` and cost, so omitting it would
  serve a scrape result to an api caller; defaults applied and string values
  trimmed so `{q}` and `{q, limit: 10}` share a key).
- TTLs per the card, replacing the old file's values: **search 24 h, fastgpt
  6 h, summarize 7 d.** Only those three domains are cached. Extract/enrich
  are per-URL metadata chains for downstream composition, rank is account
  personalization that must stay live, and Small Web browse is a free RSS feed —
  caching any of them buys little and risks serving stale composed state.
- **Single-flight in the DO, not in a module map.** `refresh.ts`'s `inflight`
  map only coalesces within one isolate; ten identical queries landing on
  different isolates would each miss and hit Kagi. `ResultCache.claim()` is
  synchronous end to end (like every `Meter` method — no `await` between read
  and write), so exactly one caller wins the key; losers poll `lookup()` until
  the winner stores. An isolate-local promise map sits in front as a fast path
  only — correctness never depends on it.
- `meta.cache_hit` (existing) and new `meta.cache_age_s` (seconds since the
  upstream fetch; absent on miss). A hit reports `elapsed_ms` for the fast
  path and `cost_cents: 0` when the stored response carried a cost — the spend
  was settled at fetch time (Meter is untouched by hits), so claiming the old
  cost again would mislead per-call accounting.
- `max_age_s` param on the three cached surfaces (MCP tools, REST): entries
  older than it are treated as misses; **`max_age_s=0` skips the read, fetches
  fresh, and still stores** (refreshes the entry for the next caller).
- Cached responses never touch `takeKagiCall` or `guardBillable` — both live in
  the impls below the facade, and the facade returns before invoking them. A
  repeat query within TTL therefore makes 0 Kagi calls and consumes 0 budget.
- **Hourly purge cron** (`0 * * * *` → `scheduled()` → `ResultCache.purge()`).
  Kagi results stay transient: nothing survives past its TTL, and the loser
  path lazily deletes expired rows on read.
- **Hit rate via a `kagi://cache-stats` MCP resource** (`hits`, `misses`,
  `stores`, `entries`, `hit_rate`, per-domain breakdown). L1 hits increment
  the DO counter explicitly, otherwise the fast path would make the stats lie.
  A missing/broken binding fails open (fetch direct) — the cache is an
  optimization and must never break serving.

## Consequences

- `MetaBlock` gains optional `cache_age_s`; five MCP tool input schemas gain
  optional `max_age_s`; the tools/list + outputSchema snapshots change
  accordingly (regenerated, diff reviewed).
- New `RESULT_CACHE` binding and a `v4` SQLite migration; `scheduled()` handler
  on the worker export.
- Tests: key derivation/normalization/TTLs in the unit project; DO atomicity
  (concurrent claims, expiry, purge, stats) plus facade read-through
  (hit/miss/bypass, 10-concurrent → 1 upstream, 0 Kagi calls on repeat) in the
  workers project.

## Alternatives considered

- **D1 instead of DO-SQLite.** Same durability, but the claim would need a
  read-then-write round-trip through the D1 HTTP API with no compare-and-swap —
  the exact race ADR 0006 moved the counters into a DO to close. DO-SQLite
  keeps claim atomic.
- **Folding the table into `Meter`.** No new binding or migration, but Meter's
  contract is protective counters; mixing a best-effort cache into the fail-
  closed budget path risks one taking down the other. Separate DO, separate
  blast radius.
- **Cache API only (custom-domain-only).** Keeps `workers.dev` clients hitting
  Kagi on every query — the bug this card fixes. L2 exists so the fix holds on
  every route clients actually use.
