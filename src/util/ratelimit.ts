// Per-bearer rate limiter.
//
// Counters live in the Meter Durable Object, addressed by
// idFromName(sha256_16(bearer)) — one instance per bearer, so buckets are
// naturally sharded and each instance lands near the caller that created it.
// The bearer is hashed before use as the instance name: the raw value never
// reaches storage or logs.
//
// This used to be a KV read-then-write, which under-counted under concurrency
// (see docs/adr/0006-serialize-rate-and-spend-counters.md). The check and the
// increment now happen inside a single synchronous DO method, so they cannot
// interleave.

import type { Env } from "../env.js";
import type { RateVerdict } from "../meter/meter.js";

export type RateLimitResult = RateVerdict;

async function bearerHash(bearer: string): Promise<string> {
  const bytes = new TextEncoder().encode(bearer);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function readLimit(env: Env): number {
  const raw = env.PER_BEARER_RPM ?? "60";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function checkAndIncrement(
  env: Env,
  bearer: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const limit = readLimit(env);
  if (limit <= 0) return { allowed: true, limit_rpm: 0, count: 0 };

  const ms = now.getTime();
  const minute = Math.floor(ms / 60_000);
  const id = env.METER.idFromName(await bearerHash(bearer));
  return env.METER.get(id).checkRate(limit, minute, ms % 60_000);
}
