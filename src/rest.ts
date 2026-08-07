// REST handlers for /search and /summarize.
//
// Both endpoints route through the KagiClient facade (mode-aware). Response
// shape mirrors the canonical types.ts contracts so REST callers get the
// same structured data as MCP callers.

import type { Env } from "./env.js";
import { jsonError, jsonOk } from "./util/errors.js";
import { createKagiClient, type KagiClient } from "./kagi/client.js";
import {
  KagiAuthError,
  KagiBudgetExceededError,
  KagiConfirmRequiredError,
  KagiError,
  KagiNotConfiguredError,
  KagiParseError,
  KagiRateLimitError,
  KagiUnsupportedInModeError,
  KagiUpstreamError,
} from "./kagi/errors.js";
import { isSupportedLanguage } from "./kagi/languages.js";
import { logWarn } from "./util/log.js";
import type { SearchResponse } from "./kagi/types.js";

interface SearchBody {
  queries?: unknown;
  limit?: unknown;
  impl?: unknown;
}

interface SummarizeBody {
  url?: unknown;
  summary_type?: unknown;
  target_language?: unknown;
  impl?: unknown;
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { queries, limit, impl } = body;
  if (!Array.isArray(queries) || queries.length === 0) {
    return jsonError(400, "missing-queries", "Body needs { queries: string[] }");
  }
  const normQueries: string[] = [];
  for (const q of queries) {
    if (typeof q !== "string" || q.trim().length === 0) {
      return jsonError(400, "invalid-query", "All queries must be non-empty strings");
    }
    normQueries.push(q.trim());
  }

  let normLimit = 10;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return jsonError(400, "invalid-limit", "limit must be an integer between 1 and 50");
    }
    normLimit = limit;
  }
  const normImpl = normalizeImpl(impl);
  if (normImpl === "__invalid__") {
    return jsonError(400, "invalid-impl", "impl must be 'scrape' or 'api'");
  }

  let client: KagiClient;
  try {
    client = createKagiClient(env);
  } catch (err) {
    return kagiErrorResponse(err);
  }

  const settled = await Promise.allSettled(
    normQueries.map((q) =>
      withTimeout(client.search({ q, limit: normLimit, impl: normImpl }), 15_000),
    ),
  );

  const results: Array<{
    query: string;
    ok: boolean;
    data?: SearchResponse;
    error?: string;
  }> = [];
  for (let i = 0; i < normQueries.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      results.push({ query: normQueries[i], ok: true, data: s.value });
    } else {
      results.push({
        query: normQueries[i],
        ok: false,
        error: reasonToString(s.reason),
      });
    }
  }
  return jsonOk({ mode: client.mode, results });
}

export async function handleSummarize(request: Request, env: Env): Promise<Response> {
  let body: SummarizeBody;
  try {
    body = (await request.json()) as SummarizeBody;
  } catch {
    return jsonError(400, "invalid-json", "Body must be JSON");
  }

  const { url, summary_type, target_language, impl } = body;
  if (typeof url !== "string" || url.trim().length === 0) {
    return jsonError(400, "missing-url", "Body needs { url: string }");
  }
  const type =
    summary_type === undefined || summary_type === "summary" || summary_type === "takeaway"
      ? (summary_type ?? "summary")
      : null;
  if (type === null) {
    return jsonError(400, "invalid-summary-type", "summary_type must be 'summary' or 'takeaway'");
  }
  let language = "EN";
  if (target_language !== undefined) {
    if (typeof target_language !== "string" || !isSupportedLanguage(target_language)) {
      return jsonError(400, "invalid-language", `target_language not supported`);
    }
    language = target_language;
  }
  const normImpl = normalizeImpl(impl);
  if (normImpl === "__invalid__") {
    return jsonError(400, "invalid-impl", "impl must be 'scrape' or 'api'");
  }

  let client: KagiClient;
  try {
    client = createKagiClient(env);
  } catch (err) {
    return kagiErrorResponse(err);
  }

  try {
    const data = await client.summarize({
      kind: "url",
      ref: url,
      language,
      style: type,
      impl: normImpl,
    });
    return jsonOk({ ok: true, mode: client.mode, data });
  } catch (err) {
    return kagiErrorResponse(err);
  }
}

function normalizeImpl(v: unknown): "scrape" | "api" | undefined | "__invalid__" {
  if (v === undefined) return undefined;
  if (v === "scrape" || v === "api") return v;
  return "__invalid__";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function reasonToString(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

export function kagiErrorResponse(err: unknown): Response {
  if (err instanceof KagiNotConfiguredError) {
    return jsonError(503, "kagi-not-configured", err.message);
  }
  if (err instanceof KagiAuthError) {
    return jsonError(401, "kagi-auth", err.message);
  }
  if (err instanceof KagiConfirmRequiredError) {
    return jsonError(400, "kagi-confirm-required", err.message);
  }
  if (err instanceof KagiUnsupportedInModeError) {
    return jsonError(400, "kagi-unsupported-in-mode", err.message);
  }
  if (err instanceof KagiBudgetExceededError) {
    return jsonError(402, "kagi-budget-exceeded", err.message);
  }
  if (err instanceof KagiRateLimitError) {
    return jsonError(429, "kagi-rate-limit", err.message);
  }
  if (err instanceof KagiParseError) {
    return jsonError(502, "kagi-parse-failed", err.message);
  }
  if (err instanceof KagiUpstreamError) {
    return jsonError(502, "kagi-upstream", err.message);
  }
  if (err instanceof KagiError) {
    return jsonError(500, `kagi-${err.kind}`, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  logWarn("unhandled error in REST handler", { msg });
  return jsonError(500, "internal", msg);
}
