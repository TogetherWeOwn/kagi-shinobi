// Per-bearer rate limiter — one KV counter per (bearer-hash, epoch minute).
//
// TTL is 90s so counters auto-clean without a cron. Since KV puts are
// eventually consistent globally but strongly consistent within a namespace
// region, we accept some over-count under bursty concurrent load; that's a
// safe direction (we throttle a hair too aggressively, never too loosely).
//
// The bearer is SHA-256'd before use as a key — never logged in plaintext.

import type { Env } from "../env.js";

export interface RateLimitResult {
  allowed: boolean;
  limit_rpm: number;
  count: number;
  retry_after_seconds?: number;
}

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

  const minute = Math.floor(now.getTime() / 60_000);
  const key = `rl:${await bearerHash(bearer)}:${minute}`;
  const currentRaw = await env.TOKEN_KV.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;

  if (current >= limit) {
    const nextMinute = (minute + 1) * 60_000;
    const retry = Math.max(1, Math.ceil((nextMinute - now.getTime()) / 1000));
    return { allowed: false, limit_rpm: limit, count: current, retry_after_seconds: retry };
  }
  await env.TOKEN_KV.put(key, String(current + 1), { expirationTtl: 90 });
  return { allowed: true, limit_rpm: limit, count: current + 1 };
}
