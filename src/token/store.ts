// KV-backed session token store.
//
// Layout: single KV key (`TOKEN_KV_KEY`) holding a JSON envelope. Wrapping in
// an envelope (instead of storing the raw token) lets us track when it was
// last refreshed and whether the last request marked it stale, which drives
// the /health endpoint and the refresh decision.

import type { Env } from "../env.js";

export interface TokenEnvelope {
  token: string;
  updatedAt: number;
  source: "secret" | "admin" | "browser-refresh";
  stale?: boolean;
  staleAt?: number;
  staleReason?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let memoryCache: { env: TokenEnvelope; loadedAt: number } | null = null;

export async function loadToken(env: Env): Promise<TokenEnvelope | null> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.loadedAt < CACHE_TTL_MS) {
    return memoryCache.env;
  }

  const raw = await env.TOKEN_KV.get(env.TOKEN_KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TokenEnvelope;
      memoryCache = { env: parsed, loadedAt: now };
      return parsed;
    } catch {
      // Fall through to seed from secret.
    }
  }

  // First boot: seed from the KAGI_SESSION_TOKEN secret if present.
  if (env.KAGI_SESSION_TOKEN) {
    const seeded: TokenEnvelope = {
      token: env.KAGI_SESSION_TOKEN,
      updatedAt: now,
      source: "secret",
    };
    await saveToken(env, seeded);
    return seeded;
  }

  return null;
}

export async function saveToken(env: Env, envelope: TokenEnvelope): Promise<void> {
  const value = JSON.stringify(envelope);
  await env.TOKEN_KV.put(env.TOKEN_KV_KEY, value);
  memoryCache = { env: envelope, loadedAt: Date.now() };
}

export async function markStale(
  env: Env,
  reason: string,
): Promise<TokenEnvelope | null> {
  const current = await loadToken(env);
  if (!current) return null;
  const updated: TokenEnvelope = {
    ...current,
    stale: true,
    staleAt: Date.now(),
    staleReason: reason,
  };
  await saveToken(env, updated);
  return updated;
}

export function clearMemoryCache(): void {
  memoryCache = null;
}
