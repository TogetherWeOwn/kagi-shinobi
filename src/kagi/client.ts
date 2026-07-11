// High-level Kagi client used by both the MCP tools and the REST endpoints.
// Adds token management on top of the raw search() / summarize() functions:
//   1. Pull current token from KV (seeded from KAGI_SESSION_TOKEN secret).
//   2. Call upstream.
//   3. On KagiAuthError: mark KV entry stale, try Browser Rendering refresh
//      (if enabled), retry ONCE with the fresh token, then give up.
//
// The single retry cap keeps a bad password from thrashing the refresh loop.

import type { Env } from "../env.js";
import { KagiAuthError } from "./errors.js";
import { search, type SearchResponse } from "./search.js";
import { summarize, type SummarizeOptions, type SummarizeResponse } from "./summarize.js";
import { loadToken, markStale } from "../token/store.js";
import { refreshTokenViaBrowser } from "../token/refresh.js";

export class TokenUnavailableError extends Error {
  constructor(msg = "No Kagi session token available") {
    super(msg);
    this.name = "TokenUnavailableError";
  }
}

async function currentToken(env: Env): Promise<string> {
  const envelope = await loadToken(env);
  if (envelope && !envelope.stale) return envelope.token;

  // No token or stale — try Browser Rendering bootstrap/refresh. This is the
  // "auto get the token as needed" behavior: if there's nothing in KV and no
  // KAGI_SESSION_TOKEN secret was seeded, we log into Kagi headlessly and
  // populate KV on first request.
  const result = await refreshTokenViaBrowser(env);
  if (result.ok && result.token) return result.token;

  if (envelope) return envelope.token; // Stale is better than nothing.
  throw new TokenUnavailableError(
    `No Kagi session token available and auto-refresh unavailable: ${result.reason ?? "unknown"}`,
  );
}

async function refreshOrThrow(env: Env, reason: string): Promise<string> {
  await markStale(env, reason);
  const result = await refreshTokenViaBrowser(env);
  if (!result.ok || !result.token) {
    throw new KagiAuthError(
      `Kagi token stale and refresh unavailable: ${result.reason ?? "unknown"}`,
    );
  }
  return result.token;
}

export async function searchWithAuth(
  env: Env,
  query: string,
  limit?: number,
): Promise<SearchResponse> {
  const token = await currentToken(env);
  try {
    return await search(query, token, limit);
  } catch (err) {
    if (!(err instanceof KagiAuthError)) throw err;
    const fresh = await refreshOrThrow(env, "search 401/403");
    return await search(query, fresh, limit);
  }
}

export async function summarizeWithAuth(
  env: Env,
  input: string,
  options: SummarizeOptions,
): Promise<SummarizeResponse> {
  const token = await currentToken(env);
  try {
    return await summarize(input, token, options);
  } catch (err) {
    if (!(err instanceof KagiAuthError)) throw err;
    const fresh = await refreshOrThrow(env, "summarize 401/403");
    return await summarize(input, fresh, options);
  }
}
